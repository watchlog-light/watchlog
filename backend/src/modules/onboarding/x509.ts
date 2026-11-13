// SPDX-License-Identifier: AGPL-3.0-only
// The pod map's CA and the cluster-agent's certificate (ADR-066) for a manifest served at
// /install.yaml (ADR-176). The chart makes them with genCA at install time; a manifest
// rendered once would give every cluster the same private key, so the backend makes a new
// pair for each manifest. node:crypto makes and signs the keys but has no certificate
// builder, so the few DER structures an X.509 v3 certificate needs are written here (no new
// dependency). ECDSA P-256 with SHA-256; the agents read them with Go's crypto/tls.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const der = (tag: number, content: Buffer): Buffer => {
  const n = content.length;
  const len =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, content]);
};
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => der(0x31, Buffer.concat(parts));
const explicit = (n: number, content: Buffer) => der(0xa0 + n, content);
const octets = (b: Buffer) => der(0x04, b);
const bits = (b: Buffer, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), b]));
const TRUE = Buffer.from([0x01, 0x01, 0xff]);

function integer(b: Buffer): Buffer {
  let v = b;
  while (v.length > 1 && v[0] === 0 && v[1]! < 0x80) v = v.subarray(1);
  return der(0x02, v[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return der(0x06, Buffer.from(out));
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280 §4.1.2.5). */
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(iso.slice(2), 'ascii'))
    : der(0x18, Buffer.from(iso, 'ascii'));
}

const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const ext = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [TRUE] : []), octets(value));

/** SHA-1 of the subject public key, RFC 5280 §4.2.1.2 method (1). */
function keyId(spki: Buffer): Buffer {
  // The SPKI is SEQUENCE { AlgorithmIdentifier, BIT STRING }: the key is the BIT STRING's
  // content after its unused-bits byte; P-256's uncompressed point is the last 65 bytes.
  return createHash('sha1')
    .update(spki.subarray(spki.length - 65))
    .digest();
}

interface Issued {
  pem: string;
  key: KeyObject;
  spki: Buffer;
  subject: Buffer;
}

function certificate(opts: {
  cn: string;
  issuer?: Issued;
  ca: boolean;
  dnsNames?: string[];
  days: number;
  now: Date;
}): Issued & { keyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = name(opts.cn);
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const notBefore = new Date(opts.now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(opts.now.getTime() + opts.days * 24 * 60 * 60 * 1000);
  const extensions = opts.ca
    ? [
        ext('2.5.29.19', true, seq(TRUE)),
        // digitalSignature, keyCertSign, cRLSign
        ext('2.5.29.15', true, bits(Buffer.from([0x86]), 1)),
        ext('2.5.29.14', false, octets(keyId(spki))),
      ]
    : [
        ext('2.5.29.19', true, seq()),
        // digitalSignature, keyEncipherment
        ext('2.5.29.15', true, bits(Buffer.from([0xa0]), 5)),
        ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
        ext(
          '2.5.29.17',
          false,
          seq(...(opts.dnsNames ?? []).map((n) => der(0x82, Buffer.from(n, 'ascii')))),
        ),
        ...(opts.issuer ? [ext('2.5.29.35', false, seq(der(0x80, keyId(opts.issuer.spki))))] : []),
      ];
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    opts.issuer?.subject ?? subject,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, opts.issuer?.key ?? privateKey);
  const cert = seq(tbs, ECDSA_SHA256, bits(signature));
  const b64 = cert.toString('base64').replace(/.{1,64}/g, '$&\n');
  return {
    pem: `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`,
    key: privateKey,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    spki,
    subject,
  };
}

/**
 * A new CA and a certificate for the cluster-agent's service, as the chart's genCA and
 * genSignedCert make them: the CA named watchlog-podmap-ca, the service's two DNS names,
 * ten years.
 */
export function podMapCertificates(service: string, now = new Date()) {
  const ca = certificate({ cn: 'watchlog-podmap-ca', ca: true, days: 3650, now });
  const leaf = certificate({
    cn: service,
    issuer: ca,
    ca: false,
    dnsNames: [service, `${service}.cluster.local`],
    days: 3650,
    now,
  });
  return { caCrt: ca.pem, tlsCrt: leaf.pem, tlsKey: leaf.keyPem };
}
