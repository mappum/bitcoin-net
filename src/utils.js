var url = require('url')

function getRandom (array) {
  return array[Math.floor(Math.random() * array.length)]
}

function parseAddress (address) {
  // if address has a protocol in it, we don't need to add a fake one
  if ((/^\w+:\/\//).test(address)) return url.parse(address)
  return url.parse('x://' + address)
}

module.exports = { getRandom, parseAddress }
