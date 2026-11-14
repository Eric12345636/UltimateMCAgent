'use strict'

const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function isExposed (bot, block) {
  const pos = block.position || block
  return NEIGHBORS.some(offset => {
    const neighbor = bot.blockAt(pos.offset(...offset), false)
    return neighbor && (neighbor.boundingBox === 'empty' || neighbor.transparent)
  })
}

module.exports = { isExposed }
