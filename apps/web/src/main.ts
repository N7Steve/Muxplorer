import { bootstrapApplication } from '@angular/platform-browser';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEs from '@angular/common/locales/es';
import { AppComponent } from './app/app';
registerLocaleData(localeEs);
bootstrapApplication(AppComponent, { providers: [{ provide: LOCALE_ID, useValue: 'es' }] }).catch(
  console.error,
);
