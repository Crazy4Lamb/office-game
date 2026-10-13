'use strict';
const os = require('node:os');
const net = require('node:net');

function isPrivateIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function networkInfo(port, host = '0.0.0.0', interfaces = os.networkInterfaces()) {
  const loopbackOnly = host === 'localhost' || host === '::1' || host.startsWith('127.');
  const addresses = [];
  const seen = new Set();
  if (!loopbackOnly) for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if ((entry.family !== 'IPv4' && entry.family !== 4) || entry.internal || entry.address.startsWith('169.254.')) continue;
      if (net.isIP(host) === 4 && host !== '0.0.0.0' && entry.address !== host) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      const virtual = /vethernet|virtual|vmware|hyper-v|wsl|docker|tap|tun|clash|vpn|zerotier|tailscale/i.test(name);
      const kind = virtual ? 'virtual' : isPrivateIPv4(entry.address) ? 'lan' : 'other';
      addresses.push({ address: entry.address, interface: name, kind, url: `http://${entry.address}:${port}` });
    }
  }
  const rank = { lan: 0, other: 1, virtual: 2 };
  addresses.sort((a, b) => rank[a.kind] - rank[b.kind] || a.interface.localeCompare(b.interface));
  const preferred = addresses.find(entry => entry.kind === 'lan');
  return {
    app: 'office-game', version: 4, port, host,
    localUrl: `http://localhost:${port}`,
    lanEnabled: !loopbackOnly,
    recommendedUrl: preferred ? preferred.url : null,
    addresses,
  };
}

module.exports = { networkInfo, isPrivateIPv4 };
