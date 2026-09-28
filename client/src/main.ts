import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error => console.warn('No se pudo registrar el service worker', error));
