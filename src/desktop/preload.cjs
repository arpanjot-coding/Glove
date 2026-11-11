// SPDX-License-Identifier: MIT
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['windowMinimize', 'windowToggleMaximize', 'windowClose', 'state', 'chooseTools', 'chooseReceiveFolder', 'openReceiveFolder', 'openToolGuide', 'refreshAndroid', 'pairAndroid', 'connectAndroid', 'startAndroidQr', 'stopAndroidQr', 'mirrorAndroid', 'stopAndroid', 'startSharing', 'stopSharing', 'addFiles', 'removeFile', 'startViewing', 'stopViewing', 'answerViewing', 'viewingConnected', 'copyText', 'copyMcpConfig']);
contextBridge.exposeInMainWorld('glove', {
  call: async (action, data) => {
    if (!actions.has(action)) throw new Error('Unknown action.');
    const result = await ipcRenderer.invoke('glove:action', action, data);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('glove:state', listener);
    return () => ipcRenderer.removeListener('glove:state', listener);
  }
});
