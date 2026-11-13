# node-domexception stand-in

`fetch-blob` (under mediasoup's `node-fetch`) imports the deprecated `node-domexception`, whose only job is to give
older Node versions `DOMException`. Node 17 and later have it built in, so this package exports that one
(`overrides` in `app/package.json`). Every published version is deprecated ("Use your platform's native DOMException
instead"), up to 2.0.2.

The node needs it too, since mediasoup is one of its packages. `scripts/node-package.mjs` copies this folder to
`dist-node/vendor/` and points the node's `package.json` at it, as dependency and override. Without that, a
server's `npm install` printed the deprecation warning (2026-11-10). `tests/scripts/node-package.test.ts` fails when
`app/` replaces a package under the node's dependencies and the node's package doesn't do the same.

`@nolyfill/domexception` was tried first and broke installs: it sets `module.exports` to `exports.default`, which
it leaves undefined, so importing it fails ("Cannot convert undefined or null to object") and mediasoup's install
script crashed.
