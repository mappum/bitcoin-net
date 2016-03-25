var through = require('through2').obj
var bitcoinjs = require('bitcoinjs-lib')
var Transaction = bitcoinjs.Transaction
var Block = bitcoinjs.Block

var fromTransaction = (tx) => {
  var output = Object.assign({}, tx)
  output.outs = output.outs.map((out) => {
    if (!out.valueBuffer) {
      throw new Error('Transaction output values must be type Buffer, with ' +
        'property name "valueBuffer"')
    }
    out = Object.assign({}, out)
    delete out.value
    return out
  })
  return output
}
var fromHeader = (header) => {
  var output = Object.assign({}, header)
  output.nTransactions = 0
  return output
}
var toTransaction = (tx) => Object.assign(new Transaction(), tx)
var toHeader = (header) => Object.assign(new Block(), header)

var encodeTransforms = {
  'tx': fromTransaction,
  'block': (block) => {
    var output = fromHeader(block)
    output.transactions = block.transactions.map(fromTransaction)
    return output
  },
  'headers': (headers) => headers.map(fromHeader),
  'merkleblock': (block) => {
    var output = fromHeader(block.header)
    output.hashes = block.hashes
    output.flags = block.flags
    return output
  }
}

var decodeTransforms = {
  'tx': toTransaction,
  'block': (block) => ({
    header: toHeader(block),
    transactions: block.transactions.map(toTransaction)
  }),
  'headers': (headers) => headers.map(toHeader),
  'merkleblock': (block) => ({
    header: toHeader(block.header),
    numTransactions: block.numTransactions,
    hashes: block.hashes,
    flags: block.flags
  })
}

function createTransformStream (transforms) {
  return through(function (message, enc, cb) {
    if (transforms[message.command]) {
      message = Object.assign({}, message)
      message.payload = transforms[message.command](message.payload)
    }
    this.push(message)
    cb(null)
  })
}

function encode () {
  return createTransformStream(encodeTransforms)
}

function decode () {
  return createTransformStream(decodeTransforms)
}

module.exports = { encode, decode }
