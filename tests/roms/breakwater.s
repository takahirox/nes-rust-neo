; SPDX-License-Identifier: CC0-1.0
; Breakwater. Catch cargo on a barge before it sinks.
.segment "HEADER"
.byte "NES", $1a, 1, 2, $30, 0, 0, 0, 0, 0, 0, 0, 0, 0

.include "game.inc"

cargoX = $20
cargoY = $21

.segment "CODE"
configure_mapper:
    lda #1
    sta bankPort
    rts

spawn_game:
    lda #120
    sta playerX
    lda #183
    sta playerY
spawn_round:
    lda #0
    sta points
drop:
    lda round
    sec
    sbc #1
    and #3
    asl a
    asl a
    asl a
    asl a
    sta cargoX
    lda points
    asl a
    asl a
    asl a
    clc
    adc cargoX
    adc #120
    sta cargoX
    lda #64
    sta cargoY
    jmp draw_sprites

step_game:
    lda pad
    and #1
    beq @left
    lda playerX
    cmp #224
    bcs @left
    inc playerX
    inc playerX
@left:
    lda pad
    and #2
    beq @fall
    lda playerX
    cmp #14
    bcc @fall
    dec playerX
    dec playerX
@fall:
    inc cargoY
    lda round
    cmp #2
    bcc @touch
    inc cargoY
@touch:
    lda cargoY
    cmp #178
    bcc draw_sprites
    lda cargoX
    sec
    sbc playerX
    clc
    adc #6
    cmp #22
    bcs @miss
    inc points
    lda points
    cmp #3
    beq @round
    lda #$7f
    jsr tone
    jmp drop
@round:
    inc round
    lda #$3f
    jsr tone
    jmp spawn_round
@miss:
    lda #$fb
    jsr tone
    dec lives
    bne @again
    lda #2
    sta mode
    lda #$ff
    sta $0200
    sta $0204
    sta $0208
    rts
@again:
    jmp drop

draw_sprites:
    lda playerY
    sta $0200
    sta $0204
    lda #4
    sta $0201
    lda #5
    sta $0205
    lda #0
    sta $0202
    sta $0206
    lda playerX
    sta $0203
    clc
    adc #8
    sta $0207
    lda cargoY
    sta $0208
    lda #6
    sta $0209
    lda #1
    sta $020a
    lda cargoX
    sta $020b
    rts

.segment "RODATA"
bankPort: .byte $ff
title: .byte "BREAKWATER", 0
instructions: .byte "CATCH 3 - KEEP CARGO DRY", 0
palette:
.byte $03,$13,$30,$24, $03,$13,$30,$24, $03,$13,$30,$24, $03,$13,$30,$24
.byte $03,$24,$34,$30, $03,$27,$37,$30, $03,$13,$23,$30, $03,$13,$30,$24

.segment "CHR"
.res $2000, 0
.incbin "breakwater.chr"
