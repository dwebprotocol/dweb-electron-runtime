const path = require('path')
const { remote } = require('electron')
const { Client } = require('dhub')

const c = new Client()

const REQUIRE_BASE = new Set(require('module').builtinModules)

// natives bundled
REQUIRE_BASE.add('sodium-universal')
REQUIRE_BASE.add('sodium-native')
REQUIRE_BASE.add('utp-native')
REQUIRE_BASE.add('fd-lock')
REQUIRE_BASE.add('electron')

const isBase = REQUIRE_BASE.has.bind(REQUIRE_BASE) // make it none overwritable
const requireNative = require

let config = {}
const preload = remote.getCurrentWindow().dhubPreload || {}

try {
  const hash = window.location.hash
  if (hash) config = JSON.parse(decodeURIComponent(window.location.hash.replace('#', '')))
} catch (_) {}

// TODO: dwebify
window.require = require('module').createRequire(config.app)

window.dhub = {
  require: window.require,
  preload,
  config,
  basestore: c.basestore,
  network: c.network,
}

function getSource (name, filename, host, trace) {
  const preloaded = trace[name + '@' + filename]
  if (preloaded) return preloaded

  const xhr = new XMLHttpRequest()
  const enc = encodeURIComponent

  xhr.open('GET', 'cjs://require?name=' + enc(name) + '&filename=' + enc(filename) + '&key=' + enc(host), false)
  try {
    xhr.send(null)
  } catch (err) {
    throw new Error('Cannot require ' + name + ' from ' + filename)
  }

  if (xhr.statusText !== 'OK') throw new Error('Cannot require ' + name + ' from ' + filename)

  const fname = xhr.getResponseHeader('X-Filename')
  const dname = xhr.getResponseHeader('X-Dirname')

  trace[name + '@' + filename] = fname

  return {
    fname,
    dname,
    source: xhr.responseText
  }
}

function makeRequire (host, filename, compile, cache, trace) {
  if (!compile) compile = new Function('module', 'exports', '__filename', '__dirname', 'require', '__src', 'eval(__src)')
  if (!cache) cache = {}
  if (!trace) trace = {}

  require.cache = cache
  require.trace = trace
  require.preload = preload

  return require

  function preload (map) {
    if (!map) map = require.trace

    const all = []
    const fetches = new Map()
    for (const key of Object.keys(map)) {
      if (require.trace[key]) continue

      const fname = map[key]
      const dname = path.dirname(fname)

      let f = fetches.get(fname)
      if (!f) fetches.set(fname, f = fetch(fname).then(r => r.text()))

      all.push(f.then(source => require.trace[key] = { source, fname, dname }))
    }

    return Promise.allSettled(all)
  }

  function require (name) {
    const base = isBase(name) ? requireNative(name) : null
    if (base) return base

    const { fname, dname, source } = getSource(name, filename, host, trace)

    if (cache[fname]) {
      return cache[fname].exports
    }

    const module = { exports: {}, filename: fname, dirname: dname }
    cache[fname] = module

    if (/\.json$/i.test(fname)) {
      module.exports = JSON.parse(source)
    } else {
      const sourceURL = host ? 'dweb://' + host + fname : 'file://' + fname
      const gen = source + '\n//# sourceURL=' + sourceURL + '\n'
      compile(module, module.exports, fname, dname, makeRequire(host, fname, compile, cache, trace), gen)
    }

    return module.exports
  }
}
