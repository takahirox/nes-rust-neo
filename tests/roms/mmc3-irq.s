; SPDX-License-Identifier: CC0-1.0
; Mapper 4 PRG switching, nametable control and CPU-visible scanline IRQ.
.segment "HEADER"
.byte "NES", $1a, 2, 0, $40, 0, 0, 0, 0, 0, 0, 0, 0, 0

.segment "BANK0"
.byte $30
.segment "BANK1"
.byte $31
.segment "BANK2"
.byte $32

.segment "CODE"
result = $00
irqs = $01

reset:
    sei
    cld
    ldx #$ff
    txs
    inx
    stx $2000
    stx $2001
    stx $4015
    stx $e000
    lda #$40
    sta $4017

    inc result
    lda #6
    sta $8000
    lda #1
    sta $8001
    lda $8000
    cmp #$31
    bne failed
    lda #$46
    sta $8000
    lda $8000
    cmp #$32
    bne failed
    lda $c000
    cmp #$31
    bne failed

    inc result
    bit $2002
@wait:
    bit $2002
    bpl @wait
    lda #0
    sta $a000
    lda #$20
    sta $2006
    lda #0
    sta $2006
    lda #$a7
    sta $2007
    lda #$28
    sta $2006
    lda #0
    sta $2006
    lda $2007
    lda $2007
    cmp #$a7
    bne failed

    inc result
    lda #3
    sta $c000
    sta $c001
    sta $e001
    lda #8
    sta $2000
    lda #$18
    sta $2001
    cli
@waitIRQ:
    lda irqs
    cmp #8
    bcc @waitIRQ
    sei
    sta $e000
    lda #$a5
    sta result
failed:
    jmp failed

irq:
    pha
    lda #0
    sta $e000
    inc irqs
    sta $e001
    pla
    rti
nmi:
    rti

.segment "VECTORS"
.word nmi, reset, irq
