// SPDX-License-Identifier: MIT
export const brandSize = 64;
export const brandRadius = 18;
export const brandBlue = '#2563eb';
export const brandOutline = [
  ['M', 44.8, 20.2],
  ['C', 41.6, 17.2, 37.5, 15.6, 32, 15.6],
  ['C', 22.4, 15.6, 15.3, 22.7, 15.3, 32],
  ['C', 15.3, 41.3, 22.5, 48.4, 32, 48.4],
  ['C', 38.9, 48.4, 44.9, 45.3, 48.4, 40.7],
  ['L', 48.4, 30.2],
  ['L', 31.5, 30.2],
  ['L', 31.5, 36.8],
  ['L', 41.5, 36.8],
  ['L', 41.5, 38.3],
  ['C', 39.5, 40.4, 36.3, 41.8, 32, 41.8],
  ['C', 26.1, 41.8, 22, 37.8, 22, 32],
  ['C', 22, 26.2, 26.1, 22.2, 32, 22.2],
  ['C', 35.2, 22.2, 38, 23.3, 40.1, 25.4],
  ['Z'],
];

export const brandPath = brandOutline.map(([command, ...points]) => command + points.join(' ')).join(' ');
export const brandSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${brandSize}" height="${brandSize}" viewBox="0 0 ${brandSize} ${brandSize}"><rect width="${brandSize}" height="${brandSize}" rx="${brandRadius}" fill="${brandBlue}"/><path d="${brandPath}" fill="#fff"/></svg>`;
