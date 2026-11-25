; SPDX-License-Identifier: CC0-1.0
; Orbit Salvage. Collect three beacons and avoid the rover.
.segment "HEADER"
.byte "NES", $1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0

.include "game.inc"

beaconX = $20
beaconY = $21
roverX = $22
roverY = $23
roverDir = $24

.segment "CODE"
configure_mapper:
    rts

spawn_game:
    lda #3
    sta lives
spawn_round:
    lda #40
    sta playerX
    lda #96
    sta playerY
    lda #72
    sta beaconX
    lda round
    and #7
    asl a
    asl a
    clc
    adc #92
    sta beaconY
    lda #180
    sta roverX
    lda #160
    sta roverY
    lda #1
    sta roverDir
    lda #0
    sta points
    jmp draw_sprites

step_game:
    lda pad
    and #1
    beq @left
    lda playerX
    cmp #237
    bcs @left
    inc playerX
@left:
    lda pad
    and #2
    beq @up
    lda playerX
    cmp #16
    bcc @up
    dec playerX
@up:
    lda pad
    and #8
    beq @down
    lda playerY
    cmp #62
    bcc @down
    dec playerY
@down:
    lda pad
    and #4
    beq @rover
    lda playerY
    cmp #178
    bcs @rover
    inc playerY
@rover:
    lda roverDir
    beq @roverLeft
    inc roverX
    lda roverX
    cmp #232
    bcc @roverVertical
    lda #0
    sta roverDir
    jmp @roverVertical
@roverLeft:
    dec roverX
    lda roverX
    cmp #24
    bcs @roverVertical
    lda #1
    sta roverDir
@roverVertical:
    lda round
    cmp #2
    bcc @collisions
    lda ticks
    and #$3f
    cmp #32
    bcc @rise
    inc roverY
    jmp @collisions
@rise:
    dec roverY
@collisions:
    lda roverX
    sec
    sbc playerX
    clc
    adc #6
    cmp #13
    bcs @beacon
    lda roverY
    sec
    sbc playerY
    clc
    adc #6
    cmp #13
    bcs @beacon
    lda #$ef
    jsr tone
    dec lives
    bne @respawn
    lda #2
    sta mode
    jmp hide_sprites
@respawn:
    lda #40
    sta playerX
    lda #96
    sta playerY
@beacon:
    lda beaconX
    sec
    sbc playerX
    clc
    adc #6
    cmp #13
    bcs draw_sprites
    lda beaconY
    sec
    sbc playerY
    clc
    adc #6
    cmp #13
    bcs draw_sprites
    inc points
    lda points
    cmp #3
    beq @round
    lda beaconX
    clc
    adc #32
    sta beaconX
    lda #$57
    jsr tone
    jmp draw_sprites
@round:
    inc round
    lda #$43
    jsr tone
    jmp spawn_round

draw_sprites:
    lda playerY
    sta $0200
    lda #1
    sta $0201
    lda #0
    sta $0202
    lda playerX
    sta $0203
    lda beaconY
    sta $0204
    lda #2
    sta $0205
    lda #1
    sta $0206
    lda beaconX
    sta $0207
    lda roverY
    sta $0208
    lda #3
    sta $0209
    lda #2
    sta $020a
    lda roverX
    sta $020b
    rts

hide_sprites:
    lda #$ff
    sta $0200
    sta $0204
    sta $0208
    rts

.segment "RODATA"
title: .byte "ORBIT SALVAGE", 0
instructions: .byte "MOVE AND COLLECT BEACONS", 0
palette:
.byte $01,$21,$30,$2c, $01,$21,$30,$2c, $01,$21,$30,$2c, $01,$21,$30,$2c
.byte $01,$2c,$30,$3c, $01,$28,$38,$30, $01,$16,$26,$30, $01,$21,$30,$2c

.segment "CHR"
.incbin "orbit.chr"
