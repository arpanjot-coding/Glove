// Original Glove code. MIT licensed. node-forge is used under BSD-3-Clause.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import forge from 'node-forge';

const pemOptions = { encoding: 'utf8', mode: 0o600 };
const serial = () => `01${randomBytes(15).toString('hex')}`;
const now = () => new Date(Date.now() - 5 * 60_000);
const later = days => new Date(Date.now() + days * 86400_000);
const xml = text => String(text).replace(/[<>&"']/g, c => ({'<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;'}[c]));

function pair() {
  return new Promise((resolve, reject) => forge.pki.rsa.generateKeyPair({bits: 2048, workers: -1}, (error, keys) => error ? reject(error) : resolve(keys)));
}

async function writePrivate(filename, text) {
  await fs.writeFile(filename, text, pemOptions);
  // Windows does not implement POSIX permission bits; the files inherit the
  // current user's application-data directory ACL there.
  await fs.chmod(filename, 0o600).catch(() => {});
}

export async function prepareCertificates(dataDir, ipAddresses) {
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  const rootPath = path.join(dataDir, 'root-ca.pem');
  const rootKeyPath = path.join(dataDir, 'root-ca-key.pem');
  let root;
  let rootKey;
  try {
    root = forge.pki.certificateFromPem(await fs.readFile(rootPath, 'utf8'));
    rootKey = forge.pki.privateKeyFromPem(await fs.readFile(rootKeyPath, 'utf8'));
    if (root.validity.notAfter < later(30) || !root.publicKey.n.equals(rootKey.n)) throw new Error('Renew CA');
  } catch {
    const keys = await pair();
    root = forge.pki.createCertificate();
    root.publicKey = keys.publicKey;
    root.serialNumber = serial();
    root.validity.notBefore = now();
    root.validity.notAfter = later(3650);
    root.setSubject([{name:'commonName', value:`Glove Local Screen ${randomBytes(4).toString('hex')}`}, {name:'organizationName', value:'Glove'}]);
    root.setIssuer(root.subject.attributes);
    root.setExtensions([
      {name:'basicConstraints', cA:true, critical:true, pathLenConstraint:0},
      {name:'keyUsage', keyCertSign:true, cRLSign:true, critical:true},
      {name:'subjectKeyIdentifier'},
    ]);
    rootKey = keys.privateKey;
    root.sign(rootKey, forge.md.sha256.create());
    await writePrivate(rootKeyPath, forge.pki.privateKeyToPem(rootKey));
    await writePrivate(rootPath, forge.pki.certificateToPem(root));
  }
  const rootPem = forge.pki.certificateToPem(root);
  const ips = [...new Set(ipAddresses)].sort();
  let cert;
  let key;
  try {
    cert = await fs.readFile(path.join(dataDir, 'server.pem'), 'utf8');
    key = await fs.readFile(path.join(dataDir, 'server-key.pem'), 'utf8');
    const parsed = forge.pki.certificateFromPem(cert);
    const parsedKey = forge.pki.privateKeyFromPem(key);
    const sans = parsed.getExtension('subjectAltName')?.altNames || [];
    if (parsed.validity.notAfter < later(7) || !parsed.publicKey.n.equals(parsedKey.n) || !root.verify(parsed) || !ips.every(ip => sans.some(s => s.type === 7 && s.ip === ip))) throw new Error('Renew leaf');
  } catch {
    const keys = await pair();
    const leaf = forge.pki.createCertificate();
    leaf.publicKey = keys.publicKey;
    leaf.serialNumber = serial();
    leaf.validity.notBefore = now();
    leaf.validity.notAfter = later(365);
    leaf.setSubject([{name:'commonName', value:'Glove Local Screen'}]);
    leaf.setIssuer(root.subject.attributes);
    leaf.setExtensions([
      {name:'basicConstraints', cA:false, critical:true},
      {name:'keyUsage', digitalSignature:true, keyEncipherment:true, critical:true},
      {name:'extKeyUsage', serverAuth:true},
      {name:'subjectAltName', altNames:[{type:2, value:'localhost'}, ...ips.map(ip => ({type:7, ip}))]},
      {name:'subjectKeyIdentifier'},
    ]);
    leaf.sign(rootKey, forge.md.sha256.create());
    cert = forge.pki.certificateToPem(leaf);
    key = forge.pki.privateKeyToPem(keys.privateKey);
    await writePrivate(path.join(dataDir, 'server-key.pem'), key);
    await writePrivate(path.join(dataDir, 'server.pem'), cert);
  }
  const rootDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(root)).getBytes(), 'binary');
  const fingerprint = createHash('sha256').update(rootDer).digest('hex').toUpperCase().match(/.{2}/g).join(':');
  return {cert, key, rootPem, rootDer, fingerprint, rootName:root.subject.getField('CN').value};
}

export function configurationProfile({rootDer, rootName}) {
  const profileUUID = randomUUID().toUpperCase();
  const payloadUUID = randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>app.glove.local-screen.${profileUUID}</string>
<key>PayloadUUID</key><string>${profileUUID}</string>
<key>PayloadDisplayName</key><string>${xml(rootName)}</string>
<key>PayloadOrganization</key><string>Glove</string>
<key>PayloadDescription</key><string>Before installing or enabling full trust, compare the actual certificate's SHA-256 fingerprint in this profile's certificate details with the Glove desktop app. If unavailable or different, cancel. Do not rely on a web page's fingerprint. Remove this profile when you stop using Glove.</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>app.glove.local-screen.ca.${payloadUUID}</string>
<key>PayloadUUID</key><string>${payloadUUID}</string>
<key>PayloadDisplayName</key><string>${xml(rootName)}</string>
<key>PayloadCertificateFileName</key><string>glove-local-screen-ca.cer</string>
<key>PayloadContent</key><data>${rootDer.toString('base64')}</data>
</dict></array></dict></plist>`;
}
