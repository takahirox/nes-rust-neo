use std::{
    env, fs,
    io::{BufWriter, Seek, Write},
    path::PathBuf,
    process::ExitCode,
};

use nes_core::{FDS_SIDE_BYTES, HEIGHT, Media, Nes, SAMPLE_RATE, WIDTH};

const DISK_SAVE_MAGIC: &[u8; 8] = b"FDS-SAV1";
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const USAGE: &str = "nes-runner GAME --frames N [--bios FILE] [--disk FRAME:SIDE|FRAME:eject]... [--disk-save-in FILE] [--disk-save-out NEW_FILE] [--replay FILE] [--expect FRAME:ADDR:BYTE]... [--video OUT.ppm] [--audio OUT.wav]\nReplay rows: first-frame last-frame pad1-hex [pad2-hex] (inclusive, frames start at 1). Expect addresses/bytes are hexadecimal. Disk side numbers start at 1 in image order.";

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

struct DiskAction {
    frame: u32,
    side: Option<usize>,
}

struct Options {
    game: PathBuf,
    bios: Option<PathBuf>,
    disk: Vec<DiskAction>,
    disk_save_in: Option<PathBuf>,
    disk_save_out: Option<PathBuf>,
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
            game: args.next().ok_or(USAGE)?.into(),
            bios: None,
            disk: Vec::new(),
            disk_save_in: None,
            disk_save_out: None,
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
                "--bios" => opts.bios = Some(value.into()),
                "--disk-save-in" => opts.disk_save_in = Some(value.into()),
                "--disk-save-out" => opts.disk_save_out = Some(value.into()),
                "--disk" => {
                    let (frame, side) = value.split_once(':').ok_or(USAGE)?;
                    let side = if side == "eject" {
                        None
                    } else {
                        Some(
                            side.parse::<usize>()?
                                .checked_sub(1)
                                .ok_or("Disk side must be at least 1")?,
                        )
                    };
                    opts.disk.push(DiskAction {
                        frame: frame.parse()?,
                        side,
                    });
                }
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
            || opts
                .disk
                .iter()
                .any(|action| action.frame == 0 || action.frame > opts.frames)
        {
            return Err("Expectation, disk action or replay extends outside the run".into());
        }
        opts.expect.sort_by_key(|expect| expect.frame);
        opts.disk.sort_by_key(|action| action.frame);
        Ok(opts)
    }
}

struct Wave {
    file: BufWriter<fs::File>,
    bytes: u32,
}

impl Wave {
    fn new(path: PathBuf, new_only: bool) -> Result<Self> {
        let mut file = BufWriter::new(create_output(path, new_only)?);
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

fn create_output(path: PathBuf, new_only: bool) -> std::io::Result<fs::File> {
    if new_only {
        fs::File::create_new(path)
    } else {
        fs::File::create(path)
    }
}

fn run(opts: Options) -> Result<()> {
    let original = fs::read(opts.game)?;
    let media = Media::parse(&original)?;
    let identity = match &media {
        Media::Disk(disk) => {
            // Match headered and headerless copies of the same original sides.
            let offset = original.len() - disk.side_count() * FDS_SIDE_BYTES;
            Some(hash(FNV_OFFSET, original[offset..].iter().copied()).to_le_bytes())
        }
        Media::Cartridge(_) => None,
    };
    let is_disk = identity.is_some();
    if !is_disk
        && (opts.bios.is_some()
            || opts.disk_save_in.is_some()
            || opts.disk_save_out.is_some()
            || !opts.disk.is_empty())
    {
        return Err("Disk options require an FDS image".into());
    }
    let bios = opts.bios.map(fs::read).transpose()?;
    let mut nes = Nes::from_media(media, bios.as_deref())?;
    if let Some(path) = opts.disk_save_in {
        let bytes = fs::read(path)?;
        let identity = identity.ok_or("Missing disk identity")?;
        let tracks = bytes
            .strip_prefix(DISK_SAVE_MAGIC.as_slice())
            .and_then(|rest| rest.strip_prefix(identity.as_slice()))
            .ok_or("Disk save version or original image identity does not match")?;
        if !nes.restore_save(tracks) {
            return Err("Disk save size does not match the image".into());
        }
    }
    if opts
        .disk
        .iter()
        .filter_map(|action| action.side)
        .any(|side| side >= nes.disk_side_count())
    {
        return Err("Disk side does not exist on this image".into());
    }
    let mut actions = opts.disk.into_iter().peekable();
    let mut wav = opts
        .audio
        .map(|path| Wave::new(path, is_disk))
        .transpose()?;
    let mut replay = opts.replay.into_iter().peekable();
    let mut expect = opts.expect.into_iter().peekable();
    let mut peak = 0.0f32;
    let mut samples = 0;
    let mut audio_hash = FNV_OFFSET;
    for frame in 1..=opts.frames {
        while let Some(action) = actions.next_if(|action| action.frame == frame) {
            if let Some(side) = action.side {
                nes.insert_disk(side);
            } else {
                nes.eject_disk();
            }
        }
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
        let mut ppm = BufWriter::new(create_output(path, is_disk)?);
        write!(ppm, "P6\n{WIDTH} {HEIGHT}\n255\n")?;
        for rgba in nes.frame().as_chunks::<4>().0 {
            ppm.write_all(&rgba[..3])?;
        }
        ppm.flush()?;
    }
    if let Some(path) = opts.disk_save_out {
        let mut file = fs::File::create_new(path)?;
        file.write_all(DISK_SAVE_MAGIC)?;
        file.write_all(&identity.ok_or("Missing disk identity")?)?;
        file.write_all(nes.save_bytes().ok_or("Missing disk data")?)?;
        file.sync_all()?;
    }
    let hardware = nes.cartridge().map_or_else(
        || format!("fds sides={}", nes.disk_side_count()),
        |cart| format!("mapper={}", cart.mapper_number()),
    );
    let pixels = hash(FNV_OFFSET, nes.frame().iter().copied());
    println!(
        "Pass | {hardware} frames={} cycles={} framebuffer_fnv64={pixels:016x} audio_samples={samples} audio_peak={peak:.5} audio_fnv64={audio_hash:016x}\nCPU {:?}",
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
