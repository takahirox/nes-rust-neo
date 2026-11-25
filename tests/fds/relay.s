; SPDX-License-Identifier: CC0-1.0
; Disk Relay. Steer the courier to the beacon with Left/Right and press A
; to deliver. Exchange disks to reach the next beacon.
.setcpu "6502"
.segment "CODE"

read_header = $e003
write_header = $e006
header_side = $0315
header_progress = $0316

side_id = $10
position = $11
progress = $12
deliveries = $13
buttons = $14
last_buttons = $15
empty_seen = $16
frames = $17
beacon = $18
handoffs = $19
saved_here = $1a

entry:
    lda #48
    sta position
    lda #$80
    sta $4089
    ldx #0
@wave:
    txa
    cmp #32
    bcc :+
    eor #63
:
    asl a
    sta $4040,x
    inx
    cpx #64
    bne @wave
    lda #0
    sta $4089
    lda #$a0
    sta $4080
    lda #$20
    sta $4082
    lda #3
    sta $4083

    ; Both sprite tiles live in writable character RAM.
    lda #0
    sta $2006
    sta $2006
    ldx #0
@tile:
    lda tiles,x
    sta $2007
    inx
    cpx #32
    bne @tile
    ldx #0
    lda #$f0
@hide:
    sta $0200,x
    inx
    inx
    inx
    inx
    bne @hide
    lda #1
    sta $0205
    jsr adopt_side
    jsr vblank
    lda #$14
    sta $2001

main:
    jsr vblank
    inc frames
    jsr draw
    lda $4032
    and #1
    bne empty
    lda empty_seen
    beq play
    lda #0
    sta empty_seen
    jsr read_header
    lda side_id
    cmp header_side
    beq :+
    lda saved_here
    beq :+
    inc handoffs
    lda #0
    sta saved_here
:
    jsr adopt_side
    jmp main

empty:
    lda #1
    sta empty_seen
    jmp main

play:
    lda #1
    sta $4016
    lsr a
    sta $4016
    ldx #8
@pad:
    lda $4016
    lsr a
    ror buttons
    dex
    bne @pad
    lda buttons
    and #$80
    beq :+
    lda position
    cmp #232
    bcs :+
    inc position
:
    lda buttons
    and #$40
    beq :+
    lda position
    cmp #16
    bcc :+
    dec position
:
    lda buttons
    eor last_buttons
    and buttons
    and #1
    ldx buttons
    stx last_buttons
    cmp #0
    bne :+
    jmp main
:
    lda beacon
    sec
    sbc position
    clc
    adc #5
    cmp #11
    bcc :+
    jmp main
:
    inc header_progress
    jsr write_header
    jsr read_header
    lda header_progress
    sta progress
    inc deliveries
    lda #1
    sta saved_here
    jmp main

adopt_side:
    lda header_side
    sta side_id
    asl a
    asl a
    asl a
    clc
    adc #64
    sta beacon
    lda header_progress
    sta progress
    rts

vblank:
    bit $2002
    bpl vblank
    rts

draw:
    lda #$3f
    sta $2006
    lda #0
    sta $2006
    ldx side_id
    lda colors,x
    sta $2007
    lda #$3f
    sta $2006
    lda #$11
    sta $2006
    lda #$30
    sta $2007
    lda #0
    sta $2005
    sta $2005
    sta $2003
    lda #111
    sta $0200
    sta $0204
    lda #0
    sta $0201
    sta $0202
    sta $0206
    lda position
    sta $0203
    lda beacon
    sta $0207
    lda #2
    sta $4014
    rts

.segment "RODATA"
tiles:
.byte $18,$3c,$7e,$ff,$ff,$7e,$3c,$18, 0,0,0,0,0,0,0,0
.byte $18,$24,$42,$81,$81,$42,$24,$18, 0,0,0,0,0,0,0,0
colors:
.byte $0f,$01,$13,$09,$06
