var tape = require('tape')
var params = require('webcoin-bitcoin')
var u = require('bitcoin-util')
var Block = require('bitcoinjs-lib').Block
var Blockchain = require('blockchain-spv')
var levelup = require('levelup')
var memdown = require('memdown')
var to = require('flush-write-stream').obj
var { HeaderStream, BlockStream } = require('blockchain-download')
var PeerGroup = require('../../').PeerGroup

var test = (name, opts, f) => {
  if (typeof opts === 'function') {
    f = opts
    opts = {}
  }
  // really high default timeout
  if (opts.timeout == null) opts.timeout = 5 * 60 * 1000
  return tape(name, opts, f)
}

test('PeerGroup constructor', (t) => {
  t.test('invalid params', (t) => {
    try {
      var peers = new PeerGroup({})
      t.fail('should have thrown')
      t.notOk(peers)
    } catch (err) {
      t.ok(err, 'error thrown')
      t.equal(err.message, 'Invalid network parameters', 'correct error message')
      t.end()
    }
  })

  t.test('valid params, no options', (t) => {
    var peers = new PeerGroup(params.net)
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.test('valid params, with options', (t) => {
    var peers = new PeerGroup(params.net, { numPeers: 4 })
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.end()
})

var numPeers = 2
var pg
test('connect', (t) => {
  // NOTE: these tests connects to real nodes
  pg = new PeerGroup(params.net, { numPeers })

  var onPeer = (peer) => {
    t.ok(peer, 'got peer')
    t.ok(peer.ready, 'peer has completed handshake')
    t.ok(peer.socket.readable, 'peer transport socket is readable')
    t.ok(peer.socket.writable, 'peer transport socket is writable')
    if (pg.peers.length < numPeers) return
    t.pass('connected to `numPeers` peers')
    pg.removeListener('peer', onPeer)
    t.end()
  }
  pg.on('peer', onPeer)
  pg.connect()
  t.ok(pg.connecting, 'pg "connecting" state is true')
})

test('peer methods', (t) => {
  t.test('randomPeer', (t) => {
    var peers = pg.peers.slice(0)
    for (var i = 0; i < 100; i++) {
      var peer = pg.randomPeer()
      t.ok(peer, 'got peer')
      var index = peers.indexOf(peer)
      if (index !== -1) peers.splice(index, 1)
      if (peers.length === 0) break
    }
    t.equal(peers.length, 0, 'all peers returned from randomPeer()')
    t.end()
  })

  t.test('getBlocks', (t) => {
    var hash = new Buffer('6a4690e6ba50e286b8c63c826399a6ac73be3f479f17406cdf90468700000000', 'hex')
    pg.getBlocks([ hash ], (err, res) => {
      t.pass('callback called')
      t.error(err, 'no error')
      t.ok(Array.isArray(res), 'result is array')
      t.equal(res.length, 1, 'result is correct length')
      t.ok(res[0].header instanceof Block, 'result has header of type Block')
      t.equal(res[0].header.nonce, 1766761990, 'header has correct nonce')
      t.ok(Array.isArray(res[0].transactions), 'result has transactions array')
      t.equal(res[0].transactions.length, 1, 'transactions array is correct length')
      t.equal(res[0].transactions[0].getId(), '3797c09006aaad367f7342e215820e499bfbb809f042c690fb7a71b8537c0868', 'transaction has correct hash')
      t.end()
    })
  })

  var chain
  t.test('setup blockchain', (t) => {
    var db = levelup('chain', { db: memdown })
    chain = new Blockchain(params.blockchain, db, { ignoreCheckpoints: true })
    chain.once('ready', () => t.end())
  })

  t.test('createHeaderStream', (t) => {
    var expectedHeaders = [
      {
        first: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048',
        last: '00000000dfd5d65c9d8561b4b8f60a63018fe3933ecb131fb37f905f87da951a'
      },
      {
        first: '0000000067217a46c49054bad67cda2da943607d326e89896786de10b07cb7c0',
        last: '00000000922e2aa9e84a474350a3555f49f06061fd49df50a9352f156692a842'
      },
      {
        first: '00000000a86f68e8de06c6b46623fdd16b7a11ad9651fa48ecbe8c731658dc06',
        last: '00000000dbbb79792303bdd1c6c4d7ab9c21bba0667213c2eca955e11230c5a5'
      },
      {
        first: '0000000055fcaf04cb9a82bb86b46a21b15fcaa75ac8c18679b0234f79c4c615',
        last: '0000000094fbacdffec05aea9847000522a258c269ae37a74a818afb96fc27d9'
      }
    ]
    var start = u.toHash('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f')
    var stop = u.toHash('0000000094fbacdffec05aea9847000522a258c269ae37a74a818afb96fc27d9')
    var stream = pg.createHeaderStream({ locator: [ start ], stop })
    t.ok(stream instanceof HeaderStream, 'got HeaderStream')
    stream.pipe(to((data, enc, cb) => {
      t.ok(Array.isArray(data), 'data is array')
      t.equal(data.length, 2000, 'data is correct length')
      t.ok(data[0] instanceof Block, 'data contains block headers (bitcoinjs Block)')
      var expected = expectedHeaders.shift()
      t.ok(expected, 'expecting more data')
      t.equal(data[0].getId(), expected.first, 'got correct first header')
      t.equal(data[1999].getId(), expected.last, 'got correct last header')
      chain.addHeaders(data, (err) => {
        t.error(err, 'headers add to blockchain')
        cb()
      })
    }, () => t.end()))
    chain.createLocatorStream().pipe(stream)
  })

  t.test('createBlockStream', (t) => {
    var stream = pg.createBlockStream()
    t.ok(stream instanceof BlockStream, 'got BlockStream')
    var lastHeight = -1
    var lastHash = u.nullHash
    stream.on('data', (data) => {
      t.equal(typeof data.height, 'number', 'data contains height')
      t.ok(data.header instanceof Block, 'data contains header (bitcoinjs Block)')
      t.equal(data.height, lastHeight + 1, 'blocks ordered by height')
      t.equal(data.header.prevHash.toString('hex'), lastHash.toString('hex'), 'block connects to previous hash')
      lastHeight++
      lastHash = data.header.getHash()
      if (lastHeight >= 100) stream.end()
    })
    stream.on('end', () => t.end())
    chain.createReadStream().pipe(stream)
  })

  t.end()
})

test('close', (t) => {
  var i = 0
  var startPeers = pg.peers.length
  pg.on('disconnect', (peer) => {
    t.ok(pg.closed, 'pg "closed" state is true')
    i++
    t.ok(peer, 'got disconnected peer')
    t.equal(pg.peers.length, startPeers - i, 'correct number of remaining peers')
  })
  pg.close((err) => {
    t.pass('close listener called')
    t.error(err, 'no error')
    t.equal(pg.peers.length, 0, 'disconnected from all peers')
    t.end()
  })
})

test('accept', (t) => {
  t.test('simple accept', (t) => {
    // TODO: create clients to test accepting
    t.test('accept without opts', (t) => {
      var pg = new PeerGroup(params.net)
      pg.accept((err) => {
        t.pass('callback called')
        t.error(err, 'no error')
        t.equal(pg.accepting, true, 'PeerGroup is accepting')
        if (!process.browser) {
          t.equal(pg.websocketPort, 8192, 'PeerGroup websocketPort is set')
        }
        pg.close(t.end.bind(t))
      })
    })
    t.test('accept with port number', (t) => {
      var pg = new PeerGroup(params.net)
      pg.accept(8190, (err) => {
        t.pass('callback called')
        t.error(err, 'no error')
        t.equal(pg.accepting, true, 'PeerGroup is accepting')
        if (!process.browser) {
          t.equal(pg.websocketPort, 8190, 'PeerGroup websocketPort is set')
        }
        pg.close(t.end.bind(t))
      })
    })
    t.test('accept with ws opts object', (t) => {
      var pg = new PeerGroup(params.net)
      pg.accept({ port: 8191 }, (err) => {
        t.pass('callback called')
        t.error(err, 'no error')
        t.equal(pg.accepting, true, 'PeerGroup is accepting')
        if (!process.browser) {
          t.equal(pg.websocketPort, 8191, 'PeerGroup websocketPort is set')
        }
        pg.close(t.end.bind(t))
      })
    })
    t.test('unaccept', (t) => {
      var pg = new PeerGroup(params.net)
      pg.accept((err) => {
        t.pass('callback called')
        t.error(err, 'no error')
        t.equal(pg.accepting, true, 'PeerGroup is accepting')
        pg.unaccept((err) => {
          t.pass('callback called')
          t.error(err, 'no error')
          t.equal(pg.accepting, false, 'PeerGroup is not accepting')
          t.end()
        })
      })
    })
    t.end()
  })
  t.end()
})
