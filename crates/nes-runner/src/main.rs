use std::{
    env, fs,
    io::{BufWriter, Seek, Write},
    path::PathBuf,
    process::ExitCode,
};

use nes_core::{HEIGHT, Nes, SAMPLE_RATE, WIDTH};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const USAGE: &str = "nes-runner ROM --frames N [--replay FILE] [--expect FRAME:ADDR:BYTE]... [--video OUT.ppm] [--audio OUT.wav]\nReplay rows: first-frame last-frame pad1-hex [pad2-hex] (inclusive, frames start at 1). Expect addresses/bytes are hexadecimal.";

#[derive(Clone, Copy)]
struct Replay {
    first: u32,
    last: u32,
    pads: [u8; 2],
}

struct Expect {
    frame: u32,
    address: u16,
    value: u8,
}

struct Options {
    rom: PathBuf,
    frames: u32,
    replay: Vec<Replay>,
    expect: Vec<Expect>,
    video: Option<PathBuf>,
    audio: Option<PathBuf>,
}

fn replay_file(path: &str) -> Result<Vec<Replay>> {
    let mut rows: Vec<Replay> = Vec::new();
    for (number, line) in fs::read_to_string(path)?.lines().enumerate() {
        let text = line.split('#').next().unwrap_or_default();
        let fields: Vec<_> = text.split_whitespace().collect();
        if fields.is_empty() {
            continue;
        }
        let [first, last, one, rest @ ..] = fields.as_slice() else {
            return Err(format!("Invalid replay row {}", number + 1).into());
        };
        let [first, last]: [u32; 2] = [first.parse()?, last.parse()?];
        if first == 0
            || first > last
            || rest.len() > 1
            || rows.last().is_some_and(|row| row.last >= first)
        {
            return Err(format!(
                "Invalid or overlapping frame range on replay row {}",
                number + 1
            )
            .into());
        }
        let two = rest.first().copied().unwrap_or("00");
        rows.push(Replay {
            first,
            last,
            pads: [u8::from_str_radix(one, 16)?, u8::from_str_radix(two, 16)?],
        });
    }
    Ok(rows)
}

impl Options {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self> {
        let mut opts = Self {
            rom: args.next().ok_or(USAGE)?.into(),
            frames: 0,
            replay: Vec::new(),
            expect: Vec::new(),
            video: None,
            audio: None,
        };
        while let Some(flag) = args.next() {
            let value = args
                .next()
                .ok_or_else(|| format!("Missing value for {flag}"))?;
            match flag.as_str() {
                "--frames" => opts.frames = value.parse()?,
                "--replay" => opts.replay = replay_file(&value)?,
                "--video" => opts.video = Some(value.into()),
                "--audio" => opts.audio = Some(value.into()),
                "--expect" => {
                    let fields: Vec<_> = value.split(':').collect();
                    let [frame, address, byte] = fields.as_slice() else {
                        return Err(USAGE.into());
                    };
                    opts.expect.push(Expect {
                        frame: frame.parse()?,
                        address: u16::from_str_radix(address, 16)?,
                        value: u8::from_str_radix(byte, 16)?,
                    });
                }
                _ => return Err(format!("Unknown option {flag}\n{USAGE}").into()),
            }
        }
        if !(1..=216_000).contains(&opts.frames) {
            return Err("Specify --frames between 1 and 216000".into());
        }
        if opts
            .expect
            .iter()
            .any(|expect| expect.frame == 0 || expect.frame > opts.frames)
            || opts.replay.last().is_some_and(|row| row.last > opts.frames)
        {
            return Err("Expectation or replay extends outside the run".into());
        }
        opts.expect.sort_by_key(|expect| expect.frame);
        Ok(opts)
    }
}

struct Wave {
    file: BufWriter<fs::File>,
    bytes: u32,
}

impl Wave {
    fn new(path: PathBuf) -> Result<Self> {
        let mut file = BufWriter::new(fs::File::create(path)?);
        file.write_all(b"RIFF")?;
        file.write_all(&[0; 4])?;
        file.write_all(b"WAVEfmt ")?;
        file.write_all(&[16, 0, 0, 0, 1, 0, 1, 0])?;
        file.write_all(&SAMPLE_RATE.to_le_bytes())?;
        file.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?;
        file.write_all(&[2, 0, 16, 0])?;
        file.write_all(b"data")?;
        file.write_all(&[0; 4])?;
        Ok(Self { file, bytes: 0 })
    }

    fn write(&mut self, samples: &[f32]) -> Result<()> {
        for &sample in samples {
            self.file
                .write_all(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
        }
        self.bytes += samples.len() as u32 * 2;
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.file.seek(std::io::SeekFrom::Start(4))?;
        self.file.write_all(&(self.bytes + 36).to_le_bytes())?;
        self.file.seek(std::io::SeekFrom::Start(40))?;
        self.file.write_all(&self.bytes.to_le_bytes())?;
        self.file.flush()?;
        Ok(())
    }
}

fn hash(mut state: u64, bytes: impl IntoIterator<Item = u8>) -> u64 {
    for byte in bytes {
        state = (state ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
    }
    state
}

fn run(opts: Options) -> Result<()> {
    let mut nes = Nes::from_ines(&fs::read(opts.rom)?)?;
    let mut wav = opts.audio.map(Wave::new).transpose()?;
    let mut replay = opts.replay.into_iter().peekable();
    let mut expect = opts.expect.into_iter().peekable();
    let mut peak = 0.0f32;
    let mut samples = 0;
    let mut audio_hash = 0xcbf2_9ce4_8422_2325;
    for frame in 1..=opts.frames {
        while replay.peek().is_some_and(|row| row.last < frame) {
            replay.next();
        }
        let pads = replay
            .peek()
            .filter(|row| row.first <= frame)
            .map_or([0; 2], |row| row.pads);
        for (port, pad) in pads.into_iter().enumerate() {
            nes.set_controller(port, pad);
        }
        if !nes.run_frame() {
            return Err(format!("CPU jam on frame {frame}: {:?}", nes.cpu_state()).into());
        }
        let audio = nes.audio();
        samples += audio.len();
        peak = audio.iter().map(|s| s.abs()).fold(peak, f32::max);
        audio_hash = hash(audio_hash, audio.iter().flat_map(|s| s.to_le_bytes()));
        if let Some(wav) = &mut wav {
            wav.write(audio)?;
        }
        while let Some(check) = expect.next_if(|check| check.frame == frame) {
            let actual = nes.peek_ram(check.address);
            if actual != Some(check.value) {
                return Err(format!(
                    "Frame {frame} RAM ${:04X}: expected {:02X}, got {actual:02X?}; {:?}",
                    check.address,
                    check.value,
                    nes.cpu_state()
                )
                .into());
            }
            println!(
                "Frame {frame} RAM ${:04X} = {:02X}: pass",
                check.address, check.value
            );
        }
    }
    if let Some(wav) = wav {
        wav.finish()?;
    }
    if let Some(path) = opts.video {
        let mut ppm = BufWriter::new(fs::File::create(path)?);
        write!(ppm, "P6\n{WIDTH} {HEIGHT}\n255\n")?;
        for rgba in nes.frame().as_chunks::<4>().0 {
            ppm.write_all(&rgba[..3])?;
        }
        ppm.flush()?;
    }
    let pixels = hash(0xcbf2_9ce4_8422_2325, nes.frame().iter().copied());
    println!(
        "Pass | mapper={} frames={} cycles={} framebuffer_fnv64={pixels:016x} audio_samples={samples} audio_peak={peak:.5} audio_fnv64={audio_hash:016x}\nCPU {:?}",
        nes.cartridge().mapper_number(),
        nes.frame_number(),
        nes.cpu_cycles(),
        nes.cpu_state(),
    );
    Ok(())
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1).peekable();
    if args
        .peek()
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match Options::parse(args).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}
