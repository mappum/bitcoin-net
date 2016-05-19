var test = require('tape')
var utils = require('../lib/utils.js')

test('getRandom', (t) => {
  var array = [ 1, 2, 3, 4, 5, 6, 7, 8 ]
  var value = utils.getRandom(array)
  t.equal(typeof value, 'number', 'value is number')
  t.notEqual(array.indexOf(value), -1, 'got value from array')
  t.ok(value >= 1, 'value within range')
  t.ok(value <= 8, 'value within range')

  value = utils.getRandom([])
  t.notOk(value, 'no value')

  t.end()
})

test('parseAddress', (t) => {
  var parsed = utils.parseAddress('protocol://hostname:123')
  t.equal(parsed.protocol, 'protocol:', 'correct protocol')
  t.equal(parsed.hostname, 'hostname', 'correct hostname')
  t.equal(parsed.port, '123', 'correct port')

  parsed = utils.parseAddress('hostname:123')
  t.equal(parsed.protocol, 'x:', 'correct protocol')
  t.equal(parsed.hostname, 'hostname', 'correct hostname')
  t.equal(parsed.port, '123', 'correct port')

  parsed = utils.parseAddress('hostname')
  t.equal(parsed.protocol, 'x:', 'correct protocol')
  t.equal(parsed.hostname, 'hostname', 'correct hostname')
  t.notOk(parsed.port, 'no port')

  t.end()
})
