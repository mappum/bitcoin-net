var through = require('through2').obj

module.exports = function TransactionStream () {
  var stream = through(function (block, enc, cb) {
    if (block.height == null || !block.header) {
      return cb(new Error('Input to TransactionStream must be a stream of blocks'))
    }
    stream.last = block
    for (var transaction of block.transactions) {
      this.push({ transaction, block })
    }
    cb(null)
  })
  stream.last = null
  return stream
}
