import express from 'express'
import basicAuth from 'express-basic-auth'
import http from 'node:http'
import path from 'node:path'
import cors from 'cors'
import { createBareServer } from '@tomphttp/bare-server-node'
import config from './config.js'

const __dirname = process.cwd()
const server = http.createServer()
const app = express()
const bareServer = createBareServer('/v/')
const PORT = 8080

if (config.challenge) {
  console.log(
    'Password protection is enabled. Usernames are: ' +
      Object.keys(config.users)
  )

  console.log(
    'Passwords are: ' +
      Object.values(config.users)
  )

  app.use(basicAuth(config))
}

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cors())

/*
 * ============================================================
 * /html
 *
 * Format:
 *
 * /html/<content-type>/<encoding>/<payload>
 *
 * Example:
 *
 * /html/text$;plain/plain/67
 *
 * Returns:
 *
 * Content-Type: text/plain
 * Body: 67
 *
 * MIME types use $; instead of /:
 *
 * text$;plain       -> text/plain
 * text$;html        -> text/html
 * application$;json -> application/json
 *
 * Encodings:
 *
 * plain
 * uri
 * base64
 *
 * URL proxy mode:
 *
 * /html/text$;html/plain/$:https://example.com
 *
 * The $: prefix means fetch the target URL.
 * ============================================================
 */

app.get('/html/*', async (req, res) => {
  try {
    const raw = req.params[0]

    if (!raw) {
      return res.status(400).send(
        'Missing content type, encoding, and payload.'
      )
    }

    /*
     * Split:
     *
     * <content-type>/<encoding>/<payload>
     */

    const firstSlash = raw.indexOf('/')

    if (firstSlash === -1) {
      return res.status(400).send(
        'Missing encoding and payload.'
      )
    }

    const contentTypeEncoded =
      raw.slice(0, firstSlash)

    const remaining =
      raw.slice(firstSlash + 1)

    const secondSlash =
      remaining.indexOf('/')

    if (secondSlash === -1) {
      return res.status(400).send(
        'Missing payload.'
      )
    }

    const encoding =
      remaining
        .slice(0, secondSlash)
        .toLowerCase()

    let payload =
      remaining.slice(secondSlash + 1)

    /*
     * Convert:
     *
     * text$;plain
     *
     * into:
     *
     * text/plain
     */

    const contentType =
      contentTypeEncoded.replace(/\$;/g, '/')

    /*
     * Basic MIME type validation.
     */

    if (
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
        contentType
      )
    ) {
      return res.status(400).send(
        'Invalid content type.'
      )
    }

    /*
     * ========================================================
     * Decode payload
     * ========================================================
     */

    if (
      encoding === 'uri' ||
      encoding === 'url' ||
      encoding === 'uri-component'
    ) {
      try {
        payload = decodeURIComponent(payload)
      } catch {
        return res.status(400).send(
          'Invalid URI encoding.'
        )
      }
    }

    else if (
      encoding === 'base64' ||
      encoding === 'b64'
    ) {
      try {
        let value = payload
          .replace(/-/g, '+')
          .replace(/_/g, '/')

        while (value.length % 4 !== 0) {
          value += '='
        }

        payload =
          Buffer.from(
            value,
            'base64'
          ).toString('utf8')
      } catch {
        return res.status(400).send(
          'Invalid Base64 data.'
        )
      }
    }

    else if (encoding === 'plain') {
      /*
       * Leave payload untouched.
       */
    }

    else {
      return res.status(400).send(
        'Unsupported encoding. Use plain, uri, or base64.'
      )
    }

    /*
     * ========================================================
     * $: URL mode
     *
     * Example:
     *
     * /html/text$;html/plain/$:https://example.com
     *
     * or:
     *
     * /html/text$;html/uri/$:https%3A%2F%2Fexample.com
     *
     * The payload has already been decoded according to the
     * selected encoding.
     * ========================================================
     */

    if (payload.startsWith('$:')) {
      let target = payload.slice(2)

      target = target.trim()

      /*
       * If there is no scheme, assume HTTPS.
       */

      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        target = 'https://' + target
      }

      let targetURL

      try {
        targetURL = new URL(target)
      } catch {
        return res.status(400).send(
          'Invalid target URL.'
        )
      }

      /*
       * Only permit HTTP(S) targets.
       */

      if (
        targetURL.protocol !== 'http:' &&
        targetURL.protocol !== 'https:'
      ) {
        return res.status(400).send(
          'Only HTTP and HTTPS URLs are supported.'
        )
      }

      try {
        const upstream = await fetch(
          targetURL.toString(),
          {
            method: 'GET',
            redirect: 'follow',
            headers: {
              'user-agent':
                req.get('user-agent') ||
                'Mozilla/5.0',
              'accept':
                req.get('accept') ||
                '*/*'
            }
          }
        )

        const body =
          Buffer.from(
            await upstream.arrayBuffer()
          )

        res.status(upstream.status)

        /*
         * Return the content using the MIME type requested
         * in the /html URL.
         */

        res.setHeader(
          'Content-Type',
          contentType
        )

        /*
         * Do not let an upstream Content-Length become stale
         * after processing.
         */

        res.removeHeader(
          'Content-Length'
        )

        return res.end(body)

      } catch (error) {
        console.error(
          'HTML URL fetch failed:',
          error
        )

        return res.status(502).send(
          'Unable to fetch target URL.'
        )
      }
    }

    /*
     * ========================================================
     * Normal content mode
     * ========================================================
     */

    res.status(200)

    res.setHeader(
      'Content-Type',
      contentType
    )

    res.setHeader(
      'Cache-Control',
      'no-store'
    )

    return res.send(payload)

  } catch (error) {
    console.error(
      'HTML endpoint error:',
      error
    )

    if (!res.headersSent) {
      return res.status(500).send(
        'Internal server error.'
      )
    }
  }
})


/*
 * ============================================================
 * Global popup cloak
 *
 * This is injected into HTML served by this Express function.
 * Any page that calls window.open() gets an about:blank popup
 * containing the same fullscreen iframe wrapper used by URL.html.
 * The destination is loaded through /url/<encoded URL>.
 * ============================================================
 */

const POPUP_CLOAK_JS = String.raw`
(() => {
  if (window.__n4xnPopupCloakInstalled) return
  window.__n4xnPopupCloakInstalled = true

  const allow =
    'accelerometer; autoplay; camera; clipboard-read; clipboard-write; ' +
    'display-capture; encrypted-media; fullscreen; geolocation; gyroscope; ' +
    'microphone; payment; picture-in-picture; speaker-selection; usb; ' +
    'web-share; xr-spatial-tracking'

  const wrapper = destination => {
    const popup = window.open('about:blank', '_blank')

    if (!popup) return null

    let target = String(destination || 'about:blank')

    try {
      target = new URL(target, location.href).toString()
    } catch (_) {}

    const wrapperURL =
      location.origin + '/url/' + encodeURIComponent(target)

    try {
      popup.document.open()
      popup.document.write(
        '<!doctype html><html><head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Loading...</title>' +
        '<style>html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#000}' +
        '#frame{position:fixed;inset:0;width:100%;height:100%;border:0}</style>' +
        '</head><body>' +
        '<iframe id="frame" src="xd://67" allow="' + allow +
        '" allowfullscreen webkitallowfullscreen mozallowfullscreen ' +
        'referrerpolicy="no-referrer"></iframe>' +
        '<script>(function(){var f=document.getElementById("frame");' +
        'var u=' + JSON.stringify(wrapperURL) + ';' +
        'function load(){f.src=u}f.addEventListener("load",load,{once:true});' +
        'setTimeout(load,1000)})();<\/script>' +
        '</body></html>'
      )
      popup.document.close()
    } catch (_) {}

    return popup
  }

  const originalOpen = window.open.bind(window)

  window.open = function(url, target, features) {
    return wrapper(
      url == null || url === '' ? 'about:blank' : url
    ) || originalOpen(
      'about:blank',
      target || '_blank',
      features
    )
  }

  document.addEventListener('click', event => {
    const link =
      event.target &&
      event.target.closest &&
      event.target.closest('a[target="_blank"],a[target="_new"]')

    if (!link) return

    const href = link.href || link.getAttribute('href')
    if (!href) return

    event.preventDefault()
    event.stopPropagation()
    wrapper(href)
  }, true)

  document.addEventListener('submit', event => {
    const form = event.target

    if (!form || !form.getAttribute) return

    const target =
      (form.getAttribute('target') || '').toLowerCase()

    if (target !== '_blank' && target !== '_new') return

    event.preventDefault()
    event.stopPropagation()
    wrapper(form.action || location.href)
  }, true)
})()
`

const POPUP_CLOAK_SCRIPT = String.raw`
(() => {
  if (window.__n4xnPopupCloakInstalled) return
  window.__n4xnPopupCloakInstalled = true

  const allow =
    'accelerometer; autoplay; camera; clipboard-read; clipboard-write; ' +
    'display-capture; encrypted-media; fullscreen; geolocation; gyroscope; ' +
    'microphone; payment; picture-in-picture; speaker-selection; usb; ' +
    'web-share; xr-spatial-tracking'

  const makeWrapper = (destination) => {
    const popup = window.open('about:blank', '_blank')

    if (!popup) return null

    let target = String(destination || 'about:blank')

    try {
      target = new URL(target, location.href).toString()
    } catch (_) {}

    const wrapperURL =
      location.origin +
      '/url/' +
      encodeURIComponent(target)

    try {
      popup.document.open()
      popup.document.write(
        '<!doctype html>' +
        '<html><head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Loading...</title>' +
        '<style>' +
        'html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#000}' +
        '#frame{position:fixed;inset:0;width:100%;height:100%;border:0}' +
        '</style>' +
        '</head><body>' +
        '<iframe id="frame" src="xd://67" ' +
        'allow="' + allow + '" allowfullscreen ' +
        'webkitallowfullscreen mozallowfullscreen ' +
        'referrerpolicy="no-referrer"></iframe>' +
        '<script>' +
        '(function(){' +
        'var f=document.getElementById("frame");' +
        'var u=' + JSON.stringify(wrapperURL) + ';' +
        'function load(){f.src=u}' +
        'f.addEventListener("load",load,{once:true});' +
        'setTimeout(load,1000);' +
        '})();' +
        '<\/script>' +
        '</body></html>'
      )
      popup.document.close()
    } catch (_) {}

    return popup
  }

  const originalOpen = window.open

  window.open = function(url, target, features) {
    let destination = url

    if (destination == null || destination === '') {
      destination = 'about:blank'
    }

    const popup = makeWrapper(destination)

    if (popup) return popup

    return originalOpen.call(
      window,
      'about:blank',
      target || '_blank',
      features
    )
  }

  document.addEventListener(
    'click',
    event => {
      const link =
        event.target &&
        event.target.closest &&
        event.target.closest('a[target="_blank"],a[target="_new"]')

      if (!link) return

      const href = link.href || link.getAttribute('href')

      if (!href) return

      event.preventDefault()
      event.stopPropagation()
      makeWrapper(href)
    },
    true
  )

  /*
   * Treat forms using target=_blank the same way.
   */
  document.addEventListener(
    'submit',
    event => {
      const form = event.target

      if (
        !form ||
        !form.getAttribute ||
        !['_blank', '_new'].includes(
          (form.getAttribute('target') || '').toLowerCase()
        )
      ) return

      event.preventDefault()
      event.stopPropagation()

      const action = form.action || location.href
      makeWrapper(action)
    },
    true
  )
})()
`

const injectPopupCloak = html => {
  if (!/<html[\s>]/i.test(html)) return html
  if (/__n4xnPopupCloakInstalled/.test(html)) return html

  const tag =
    '<script data-n4xn-popup-cloak>' +
    POPUP_CLOAK_SCRIPT.replace(/<\/script/gi, '<\\/script') +
    '</script>'

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, tag + '</head>')
  }

  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, '$&' + tag)
  }

  return tag + html
}

/*
 * Inject into HTML fetched through /x as well as normal static
 * HTML files. This keeps the popup behavior in the server entry
 * point rather than requiring every HTML page to be edited.
 */

/*
 * ============================================================
 * /url
 *
 * Serves URL.html for:
 *
 * /url
 * /url/anything
 * ============================================================
 */

app.get(
  ['/url', '/url/*'],
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'static',
        'URL.html'
      )
    )
  }
)


/*
 * Serve the UV service worker through this entry point so proxied
 * HTML receives the same popup cloak without modifying sw.js.
 */
app.get('/m/sw.js', async (req, res, next) => {
  try {
    const fs = await import('node:fs/promises')
    const swPath = path.join(__dirname, 'static', 'm', 'sw.js')
    let source = await fs.readFile(swPath, 'utf8')

    /*
     * UV's HTML branch is minified in the bundled service worker.
     * Add our same-origin popup script immediately after UV's
     * rewriteHtml() call. This means /a/ proxied documents get the
     * hook even though they never pass through /x.
     */
    const needle =
      'c.body=t.rewriteHtml(await a.text(),{document:!0,injectHead:t.createHtmlInject(this.config.handler,this.config.bundle,this.config.config,t.cookie.serialize(s,t.meta,!0),e.referrer)})'

    const replacement =
      needle +
      String.raw`;c.body=c.body.replace(/<\\/head>/i,'<script src="/popup-cloak.js"><\\/script></head>')`


    if (!source.includes(needle)) {
      console.error('Unable to patch UV service worker popup hook.')
      return res.type('application/javascript').send(source)
    }

    source = source.replace(needle, replacement)

    res.type('application/javascript').set(
      'Cache-Control',
      'no-store'
    ).send(source)
  } catch (error) {
    console.error('Unable to serve patched UV service worker:', error)
    next(error)
  }
})


app.get('/popup-cloak.js', (req, res) => {
  res.type('application/javascript').set(
    'Cache-Control',
    'no-store'
  ).send(POPUP_CLOAK_JS)
})

/*
 * ============================================================
 * Existing static files
 *
 * HTML files are read here so the global popup cloak can be
 * inserted without editing every HTML file individually.
 * ============================================================
 */

app.use(async (req, res, next) => {
  if (
    req.method !== 'GET' ||
    !/\.html$/i.test(req.path)
  ) {
    return next()
  }

  try {
    const relative =
      req.path.replace(/^\/+/, '')

    const filePath =
      path.join(
        __dirname,
        'static',
        relative
      )

    const resolved =
      path.resolve(filePath)

    const staticRoot =
      path.resolve(
        path.join(__dirname, 'static')
      )

    if (
      resolved !== staticRoot &&
      !resolved.startsWith(staticRoot + path.sep)
    ) {
      return next()
    }

    const fs =
      await import('node:fs/promises')

    const html =
      await fs.readFile(
        resolved,
        'utf8'
      )

    res.type('html').send(
      injectPopupCloak(html)
    )
  } catch (_) {
    next()
  }
})

app.use(
  express.static(
    path.join(__dirname, 'static')
  )
)

/*
 * ============================================================
 * Existing remote content routes
 * ============================================================
 */

const fetchData = async (
  req,
  res,
  next,
  baseUrl
) => {
  try {
    const reqTarget =
      `${baseUrl}/${req.params[0]}`

    const asset =
      await fetch(reqTarget)

    if (asset.ok) {
      const data =
        Buffer.from(
          await asset.arrayBuffer()
        )

      const assetType =
        (asset.headers.get('content-type') || '').toLowerCase()

      if (assetType.includes('text/html')) {
        return res.end(
          injectPopupCloak(
            data.toString('utf8')
          )
        )
      }

      res.end(data)
    } else {
      next()
    }
  } catch (error) {
    console.error(
      'Error fetching:',
      error
    )

    next(error)
  }
}

app.get(
  '/y/*',
  cors({ origin: false }),
  (req, res, next) => {
    const baseUrl =
      'https://raw.githubusercontent.com/ypxa/y/main'

    fetchData(
      req,
      res,
      next,
      baseUrl
    )
  }
)

app.get(
  '/f/*',
  cors({ origin: false }),
  (req, res, next) => {
    const baseUrl =
      'https://raw.githubusercontent.com/4x-a/x/fixy'

    fetchData(
      req,
      res,
      next,
      baseUrl
    )
  }
)

/*
 * ============================================================
 * /x
 *
 * Server-side fetch proxy.
 *
 * Example:
 *
 * /x/https://example.com
 *
 * or URI encoded:
 *
 * /x/https%3A%2F%2Fexample.com
 * ============================================================
 */

app.get('/x/*', cors(), async (req, res) => {
  try {
    let target =
      req.params[0]

    try {
      target =
        decodeURIComponent(target)
    } catch {
      return res.status(400).send(
        'Invalid URI encoding.'
      )
    }

    target =
      target.trim()

    /*
     * Allow bare domains.
     */

    if (
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(
        target
      )
    ) {
      target =
        'https://' + target
    }

    let targetURL

    try {
      targetURL =
        new URL(target)
    } catch {
      return res.status(400).send(
        'Invalid URL.'
      )
    }

    if (
      targetURL.protocol !== 'http:' &&
      targetURL.protocol !== 'https:'
    ) {
      return res.status(400).send(
        'Only HTTP and HTTPS URLs are supported.'
      )
    }

    const upstream =
      await fetch(
        targetURL.toString(),
        {
          redirect: 'follow',
          headers: {
            'user-agent':
              req.get('user-agent') ||
              'Mozilla/5.0',

            accept:
              req.get('accept') ||
              '*/*'
          }
        }
      )

    res.status(
      upstream.status
    )

    /*
     * Copy safe upstream headers.
     */

    upstream.headers.forEach(
      (value, key) => {
        if (
          ![
            'content-encoding',
            'content-length',
            'transfer-encoding',
            'connection',
            'set-cookie',
            'access-control-allow-origin'
          ].includes(
            key.toLowerCase()
          )
        ) {
          res.setHeader(
            key,
            value
          )
        }
      }
    )

    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    )

    const rawData =
      Buffer.from(
        await upstream.arrayBuffer()
      )

    const upstreamType =
      (upstream.headers.get('content-type') || '').toLowerCase()

    if (upstreamType.includes('text/html')) {
      let html = rawData.toString('utf8')
      html = injectPopupCloak(html)

      res.setHeader(
        'Content-Type',
        'text/html; charset=utf-8'
      )

      return res.end(html)
    }

    return res.end(rawData)

  } catch (error) {
    console.error(
      'Error fetching /x target:',
      error
    )

    if (!res.headersSent) {
      return res.status(502).send(
        'Unable to fetch URL.'
      )
    }
  }
})

/*
 * ============================================================
 * Existing page routes
 * ============================================================
 */

const routes = [
  {
    path: '/',
    file: 'index.html'
  },
  {
    path: '/~',
    file: 'apps.html'
  },
  {
    path: '/-',
    file: 'games.html'
  },
  {
    path: '/!',
    file: 'settings.html'
  },
  {
    path: '/0',
    file: 'tabs.html'
  },
  {
    path: '/&',
    file: 'go.html'
  },
  {
    path: '/w',
    file: 'edu.html'
  },
  {
    path: '/e',
    file: 'now.html'
  }
]

routes.forEach(
  route => {
    app.get(
      route.path,
      (req, res) => {
        res.sendFile(
          path.join(
            __dirname,
            'static',
            route.file
          )
        )
      }
    )
  }
)

/*
 * ============================================================
 * Bare server / WebSocket handling
 * ============================================================
 */

const handler = (
  req,
  res
) => {
  if (
    bareServer.shouldRoute(req)
  ) {
    return bareServer.routeRequest(
      req,
      res
    )
  }

  return app(
    req,
    res
  )
}

server.on(
  'request',
  handler
)

server.on(
  'upgrade',
  (req, socket, head) => {
    if (
      bareServer.shouldRoute(req)
    ) {
      bareServer.routeUpgrade(
        req,
        socket,
        head
      )
    } else {
      socket.end()
    }
  }
)

/*
 * ============================================================
 * Server startup
 * ============================================================
 */

server.on(
  'listening',
  () => {
    console.log(
      `Running at http://localhost:${PORT}`
    )
  }
)

/*
 * Vercel serverless handler.
 */

export default handler

/*
 * Normal local/server deployment.
 */

if (!process.env.VERCEL) {
  server.listen({
    port: PORT
  })
}
