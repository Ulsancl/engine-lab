const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engineDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('engine:open-project'),
  saveProject: payload => ipcRenderer.invoke('engine:save-project', payload),
  setBusy: busy => ipcRenderer.send('engine:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:command', listener);
    return () => ipcRenderer.removeListener('engine:command', listener);
  },
});
