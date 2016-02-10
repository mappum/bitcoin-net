var through = require('through2').obj

module.exports = function TransactionStream () {
  var stream = through(function (block, enc, cb) {
    if (block.height == null || !block.header) {
      return cb(new Error('Input to TransactionStream must be a stream of blocks'))
    }

    var txs = block.block ? block.block.transactions : block.transactions
    stream.last = block
    txs.forEach((transaction) => this.push({ transaction, block }))
    cb(null)
  })
  stream.last = null
  return stream
}
