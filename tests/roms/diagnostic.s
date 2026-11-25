; SPDX-License-Identifier: CC0-1.0
; A deterministic hardware probe that doubles as a browser persistence fixture.
.segment "HEADER"
.byte "NES", $1a, 1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0

result = $00
nmiCount = $01
pad = $02
previous = $03
savedPresses = $6000

.segment "CODE"
reset:
    sei
    cld
    ldx #$ff
    txs
    inx
    stx $2000
    stx $2001
    stx $4015
    lda #$40
    sta $4017
    bit $2002
@ready:
    bit $2002
    bpl @ready

    ; Ricoh ADC remains binary even when the decimal flag is set.
    inc result
    sed
    clc
    lda #$49
    adc #$51
    cmp #$9a
    beq :+
    jmp failed
:
    cld
    lda #$32
    sta $0123
    cmp $0923
    beq :+
    jmp failed
:

    ; Vertical mirroring and the delayed VRAM read.
    inc result
    lda #$20
    sta $2006
    lda #$00
    sta $2006
    lda #$55
    sta $2007
    lda #$28
    sta $2006
    lda #$00
    sta $2006
    lda $2007
    lda $2007
    cmp #$55
    beq :+
    jmp failed
:

    ; OAM DMA copies from CPU RAM while rendering is disabled.
    inc result
    lda #$77
    sta $0200
    lda #0
    sta $2003
    lda #2
    sta $4014
    lda $2004
    cmp #$77
    beq :+
    jmp failed
:

    ; DMC fetches one sample byte and raises the end-of-sample IRQ.
    inc result
    lda #$8f
    sta $4010
    lda #0
    sta $4012
    sta $4013
    lda #$10
    sta $4015
    lda $4015
    and #$90
    cmp #$80
    beq :+
    jmp failed
:
    lda #0
    sta $4015
    sta $4010

    inc result
    lda #$80
    sta $2000
@waitNmi:
    lda nmiCount
    beq @waitNmi
    lda #$a5
    sta result

    ; Continuous audible pulse.
    lda #1
    sta $4015
    lda #$bf
    sta $4000
    lda #0
    sta $4001
    lda #$cf
    sta $4002
    lda #$08
    sta $4003
@main:
    jmp @main

failed:
    jmp failed

nmi:
    pha
    txa
    pha
    inc nmiCount
    lda pad
    sta previous
    lda #1
    sta $4016
    lsr a
    sta $4016
    sta pad
    ldx #8
@read:
    lda $4016
    lsr a
    rol pad
    dex
    bne @read
    lda previous
    eor #$ff
    and pad
    bpl @draw
    inc savedPresses
@draw:
    lda #$3f
    sta $2006
    lda #0
    sta $2006
    lda pad
    and #$7f
    beq @saved
    and #$0f
    bne @direction
    lda pad
    lsr a
    lsr a
    lsr a
    lsr a
    and #7
@direction:
    ora #$20
    bne @color
@saved:
    lda savedPresses
    and #$0f
    ora #$10
@color:
    sta $2007
    lda #$20
    sta $2006
    lda #0
    sta $2006
    pla
    tax
    pla
irq:
    rti

.segment "RODATA"
.ifdef ALTERNATE
.byte "Different test ROM with independent battery RAM"
.endif

.segment "VECTORS"
.word nmi, reset, irq
