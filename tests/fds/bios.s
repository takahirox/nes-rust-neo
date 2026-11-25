; SPDX-License-Identifier: CC0-1.0
; Original diagnostic firmware. Its entry points are specific to Disk Relay.
.setcpu "6502"
.segment "CODE"

header = $0300
flags = $08
irq_byte = $09
dest = $00
length = $02

jmp boot
jmp read_header
jmp write_header

boot:
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
    lda #3
    sta $4023
    lda #$30
    sta $4020
    lda #2
    sta $4022
    cli
@timer:
    lda flags
    and #1
    beq @timer
@disk:
    lda $4032
    and #1
    bne @disk
    lda #$c5
    sta $4025
@interrupt:
    lda flags
    bpl @interrupt
    sei
    lda #$45
    sta $4025
    ldx #0
    lda irq_byte
    cmp #1
    bne fault
@header:
    sta header,x
    inx
    cpx #56
    beq @count
    jsr read_byte
    jmp @header
@count:
    jsr finish_block
    jsr read_byte
    cmp #2
    bne fault
    jsr read_byte
    cmp #1
    bne fault
    jsr finish_block
    ldx #0
@file:
    jsr read_byte
    sta $0340,x
    inx
    cpx #16
    bne @file
    lda $0340
    cmp #3
    bne fault
    lda $034b
    sta dest
    lda $034c
    sta dest+1
    lda $034d
    sta length
    lda $034e
    sta length+1
    jsr finish_block
    jsr read_byte
    cmp #4
    bne fault
    ldy #0
@load:
    jsr read_byte
    sta (dest),y
    inc dest
    bne :+
    inc dest+1
:
    lda length
    bne :+
    dec length+1
:
    dec length
    lda length
    ora length+1
    bne @load
    jsr finish_block
    lda #0
    sta $4025
    jmp $6000

fault:
    lda #$ee
    sta $1f
    jmp fault

; Arm the CRC check before the second CRC byte and synchronize the next block.
finish_block:
    jsr read_byte
    lda #$55
    sta $4025
    jsr read_byte
    lda $4030
    and #$10
    bne fault
    lda #5
    sta $4025
    ldy #70
:
    dey
    bne :-
    lda #$45
    sta $4025
    rts

read_byte:
    lda $4030
    bpl read_byte
    lda $4031
    rts

read_header:
    lda #$45
    sta $4025
    ldx #0
@byte:
    jsr read_byte
    sta header,x
    inx
    cpx #56
    bne @byte
    jsr finish_block
    lda #0
    sta $4025
    rts

; Rewrite block 1 with its existing metadata and the updated relay byte.
; The fixture has a 3537-cell lead gap and transfers a cell every 150 CPU cycles.
; Time the gap from drive ready with the timer IRQ masked. Leave 90 cycles for
; polling and register writes so the sync byte lands immediately after the gap.
gap_periods = 9
gap_reload = (3537 * 150 - 90) / gap_periods - 1
write_header:
    lda #1
    sta $4025
@ready:
    lda $4032
    and #2
    bne @ready
    lda #<gap_reload
    sta $4020
    lda #>gap_reload
    sta $4021
    lda #3
    sta $4022
    ldx #gap_periods
@gap:
    lda $4030
    and #1
    beq @gap
    dex
    bne @gap
    stx $4022
    lda #$80
    sta $4024
    lda #$41
    sta $4025
    jsr wait_write
    ldx #0
@body:
    lda header,x
    sta $4024
    jsr wait_write
    inx
    cpx #56
    bne @body
    lda #$51
    sta $4025
    ldx #66
:
    dex
    bne :-
    lda #0
    sta $4025
    rts
wait_write:
    lda $4030
    bpl wait_write
    rts

nmi:
    rti

irq:
    pha
    lda $4030
    and #$81
    ora flags
    sta flags
    bpl :+
    ; Status reads leave the byte pending until the data register is serviced.
    lda $4030
    and #$82
    cmp #$80
    bne @fault
    lda $4031
    sta irq_byte
    lda $4030
    and #$82
    bne @fault
:
    pla
    rti
@fault:
    jmp fault

.segment "VECTORS"
.word nmi, boot, irq
