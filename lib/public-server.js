'use strict';

const config = require('wild-config');
const http = require('http');
const http2 = require('http2');
const { normalizeDomain } = require('./tools');
const logger = require('./logger').child({ component: 'public-server' });
const { loadCertificate } = require('./certs');
const tls = require('tls');
const fs = require('fs');
const pathlib = require('path');
const zlib = require('zlib');
const db = require('./db');
const Handlebars = require('handlebars');
const { zoneStore } = require('./zone-store');

const errors = {};
Object.keys(config.public.errors).forEach(key => {
    errors[key] = Handlebars.compile(fs.readFileSync(config.public.errors[key], 'utf-8'));
});

let defaultKey, defaultCert, dhparam;
if (config.public.https.key) {
    defaultKey = fs.readFileSync(config.public.https.key, 'utf-8');
} else {
    defaultKey = fs.readFileSync(pathlib.join(__dirname, '..', 'config', 'default-privkey.pem'), 'utf-8');
}

if (config.public.https.cert) {
    defaultCert = fs.readFileSync(config.public.https.cert, 'utf-8');
} else {
    defaultCert = fs.readFileSync(pathlib.join(__dirname, '..', 'config', 'default-cert.pem'), 'utf-8');
}

if (config.public.https.dhParam) {
    dhparam = fs.readFileSync(config.public.https.dhParam, 'utf-8');
}

const sessionIdContext = 'pendingdns';

const defaultCtx = tls.createSecureContext({
    key: defaultKey,
    cert: defaultCert,
    dhparam,
    sessionIdContext
});

const getHostname = req => {
    let host =
        []
            .concat(req.headers.host || [])
            .concat(req.authority || [])
            .shift() || '';

    host = host.replace(/^\[|\]?:\d+$/g, '');
    if (!host) {
        host = req.ip || '';
    }

    if (host) {
        host = normalizeDomain(host);
    }

    return host;
};

const ctxCache = new Map();
const getSNIContext = async servername => {
    const domain = normalizeDomain(servername.split(':').shift());

    try {
        let records = await zoneStore.resolve(domain, 'URL', true);
        if (!records || !records.length) {
            // nothing found, so no redirect needed
            return defaultCtx;
        }

        const cert = await loadCertificate(domain);
        if (!cert || !cert.cert) {
            return defaultCtx;
        }

        if (ctxCache.has(domain)) {
            let { expires, ctx } = ctxCache.get(domain);
            if (expires === cert.expires.getTime()) {
                return ctx;
            }
            ctxCache.delete(domain);
        }

        const ctxOpts = {
            key: cert.key,
            cert: cert.cert,
            dhparam,
            sessionIdContext
        };

        if (config.public.https.ciphers) {
            ctxOpts.ciphers = config.public.https.ciphers;
        }

        const ctx = tls.createSecureContext(ctxOpts);

        ctxCache.set(domain, {
            expires: cert.expires.getTime(),
            ctx
        });

        return ctx;
    } catch (err) {
        return defaultCtx;
    }
};

const middleware = (req, res) => {
    req.ip = res.socket.remoteAddress;
    res.setHeader('Server', config.public.server);
    res.setHeader('Vary', 'Accept-Encoding');

    res.send = buf => {
        if (typeof buf === 'string') {
            buf = Buffer.from(buf);
        }

        const acceptEncoding = (req.headers['accept-encoding'] || '').toString();

        let zip;
        if (acceptEncoding.match(/\bgzip\b/)) {
            res.setHeader('Content-Encoding', 'gzip');
            zip = zlib.createGzip();
            zip.pipe(res);
        } else if (acceptEncoding.match(/\bdeflate\b/)) {
            res.setHeader('Content-Encoding', 'deflate');
            zip = zlib.createDeflate();
            zip.pipe(res);
        } else {
            zip = res;
        }

        if (!res.statusCode) {
            res.statusCode = 200;
        }
        zip.end(buf);
    };
};

const handler = async (req, res) => {
    const domain = getHostname(req);
    let records = await zoneStore.resolve(domain, 'URL', true);

    console.log(domain, records);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Hello World');
};

const setupHttps = () => {
    return new Promise((resolve, reject) => {
        const server = http2.createSecureServer(
            {
                key: defaultKey,
                cert: defaultCert,
                dhparam,
                sessionIdContext,
                allowHTTP1: true,
                SNICallback(servername, cb) {
                    getSNIContext(servername)
                        .then(ctx => {
                            return cb(null, ctx || defaultCtx);
                        })
                        .catch(err => {
                            logger.error({ msg: 'SNI failed', servername, err });
                            return cb(null, defaultCtx);
                        });
                }
            },
            (req, res) => {
                middleware(req, res);
                handler(req, res).catch(err => {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/html');

                    const hostname = getHostname(req).replace(/^www\./, '');

                    logger.error({ msg: 'Failed to serve redirect page', err, hostname });

                    const url = new URL(req.url, `https://${hostname}/`);
                    const route = url.pathname;

                    res.send(
                        errors.error500({
                            domain: hostname,
                            route
                        })
                    );
                });
            }
        );

        server.on('newSession', (id, data, cb) => {
            const sessionKey = `d:tls:${id.toString('hex')}`;
            db.redisWrite
                .multi()
                .set(sessionKey, data)
                .expire(sessionKey, 30 * 60)
                .exec()
                .then(() => {
                    cb();
                })
                .catch(err => {
                    logger.error({ msg: 'Failed to store TLS ticket', ticket: id.toString('hex'), err });
                    cb();
                });
        });

        server.on('resumeSession', (id, cb) => {
            const sessionKey = `d:tls:${id.toString('hex')}`;
            db.redisRead
                .multi()
                .getBuffer(sessionKey)
                // extend ticket
                .expire(sessionKey, 300)
                .exec()
                .then(result => {
                    cb(null, (result && result[0] && result[0][1]) || null);
                })
                .catch(err => {
                    logger.error({ msg: 'Failed to retrieve TLS ticket', ticket: id.toString('hex'), err });
                    cb(null);
                });
        });

        server.listen(config.public.https.port, config.public.https.host, () => {
            logger.info({ msg: 'Public HTTPS server listening', protocol: 'https', host: config.public.https.host, port: config.public.https.port });
            resolve();
        });

        server.once('error', err => {
            logger.error({ msg: 'Public HTTPS server error', protocol: 'https', host: config.public.https.host, port: config.public.https.port, err });
            reject(err);
        });
    });
};

const setupHttp = () => {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            middleware(req, res);
            handler(req, res).catch(err => {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'text/html');

                const hostname = getHostname(req).replace(/^www\./, '');

                logger.error({ msg: 'Failed to serve redirect page', err, hostname });

                const url = new URL(req.url, `https://${hostname}/`);
                const route = url.pathname;

                res.send(
                    errors.error500({
                        domain: hostname,
                        route
                    })
                );
            });
        });

        server.listen(config.public.http.port, config.public.http.host, () => {
            logger.info({ msg: 'Public HTTP server listening', protocol: 'http', host: config.public.http.host, port: config.public.http.port });
            resolve();
        });

        server.once('error', err => {
            logger.error({ msg: 'Public HTTP server error', protocol: 'http', host: config.public.http.host, port: config.public.http.port, err });
            reject(err);
        });
    });
};

const init = async () => {
    await Promise.all([setupHttps(), setupHttp()]);
};

module.exports = init;