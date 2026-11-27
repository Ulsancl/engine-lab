const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engineDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('engine:open-project'),
  saveProject: contents => ipcRenderer.invoke('engine:save-project', contents),
  saveRecovery: contents => ipcRenderer.invoke('engine:save-recovery', contents),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:command', listener);
    return () => ipcRenderer.removeListener('engine:command', listener);
  },
});
