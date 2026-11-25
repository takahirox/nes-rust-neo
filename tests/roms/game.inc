; SPDX-License-Identifier: CC0-1.0
; Shared cartridge startup, controller, audio and video routines.

mode      = $10                 ; 0 = title, 1 = playing, 2 = game over
round     = $11
playerX   = $12
playerY   = $13
points    = $14
lives     = $15
ticks     = $16
pad       = $17                 ; A B Select Start Up Down Left Right, high to low
previous  = $18
pressed   = $19
ready     = $1a
soundTime = $1b
drawPtr   = $1c                 ; 2 bytes

.segment "CODE"
reset:
    sei
    cld
    ldx #$ff
    txs
    inx
    stx $2000
    stx $2001
    stx $4010
    stx $4015
    lda #$40
    sta $4017
    bit $2002
@waitFirst:
    bit $2002
    bpl @waitFirst
    lda #0
@clear:
    sta $00,x
    inx
    bne @clear
    lda #$ff
@hide:
    sta $0200,x
    inx
    bne @hide
@waitSecond:
    bit $2002
    bpl @waitSecond

    jsr configure_mapper
    lda #$3f
    sta $2006
    stx $2006
@palette:
    lda palette,x
    sta $2007
    inx
    cpx #32
    bne @palette

    lda #$20
    sta $2006
    lda #0
    sta $2006
    ldx #3
    ldy #0
@wallRow:
    lda #0
@wallByte:
    sta $2007
    iny
    bne @wallByte
    dex
    bne @wallRow
    ; A floor with a single horizontal border.
    ldx #32
    lda #9
@floor:
    sta $2007
    dex
    bne @floor
    ldy #160
    lda #0
@lower:
    sta $2007
    dey
    bne @lower
    ldx #64
@attributes:
    sta $2007
    dex
    bne @attributes

    lda #$20
    sta $2006
    lda #$44
    sta $2006
    lda #<title
    ldx #>title
    jsr text
    lda #$20
    sta $2006
    lda #$84
    sta $2006
    lda #<instructions
    ldx #>instructions
    jsr text

    lda #1
    sta $4015
    lda #0
    sta $4001
    sta $2005
    sta $2005
    lda #$80
    sta $2000
    lda #$1e
    sta $2001

main:
    lda ready
    beq main
    lda #0
    sta ready
    jsr read_pad
    lda soundTime
    beq @buttons
    dec soundTime
    bne @buttons
    lda #$30
    sta $4000
@buttons:
    lda mode
    cmp #1
    beq @playing
    lda pressed
    and #$10
    beq main
    lda #1
    sta mode
    sta round
    lda #3
    sta lives
    jsr spawn_game
    lda #$af
    jsr tone
    jmp main
@playing:
    inc ticks
    jsr step_game
    jmp main

read_pad:
    lda pad
    sta previous
    lda #1
    sta $4016
    lsr a
    sta $4016
    sta pad
    ldx #8
@bit:
    lda $4016
    lsr a
    rol pad
    dex
    bne @bit
    lda previous
    eor #$ff
    and pad
    sta pressed
    rts

tone:
    sta $4002
    lda #$7a
    sta $4000
    lda #$08
    sta $4003
    lda #9
    sta soundTime
    rts

text:
    sta drawPtr
    stx drawPtr+1
    ldy #0
@letter:
    lda (drawPtr),y
    beq @done
    sta $2007
    iny
    bne @letter
@done:
    rts

nmi:
    pha
    txa
    pha
    tya
    pha
    bit $2002
    lda #$20
    sta $2006
    lda #$c4
    sta $2006
    lda mode
    beq @title
    cmp #2
    beq @over
    lda #<status
    ldx #>status
    jsr text
    lda #$20
    sta $2006
    lda #$ca
    sta $2006
    lda round
    and #$0f
    tax
    lda digits,x
    sta $2007
    lda #$20
    sta $2006
    lda #$d2
    sta $2006
    ldx points
    lda digits,x
    sta $2007
    lda #$20
    sta $2006
    lda #$db
    sta $2006
    ldx lives
    lda digits,x
    sta $2007
    jmp @finish
@over:
    lda #<over
    ldx #>over
    bne @message
@title:
    lda #<prompt
    ldx #>prompt
@message:
    jsr text
@finish:
    lda #0
    sta $2003
    sta $2005
    sta $2005
    lda #2
    sta $4014
    inc ready
    pla
    tay
    pla
    tax
    pla
irq:
    rti

.segment "RODATA"
status: .byte "ROUND 0  SCORE 0  LIVES 0", 0
prompt: .byte "PRESS START             ", 0
over:   .byte "GAME OVER - PRESS START ", 0
digits: .byte "0123456789ABCDEF"

.segment "VECTORS"
.word nmi, reset, irq
