import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/runs-page/runs-page.component').then(m => m.RunsPageComponent) },
  {
    path: 'runs/:id',
    loadComponent: () =>
      import('./pages/run-detail-page/run-detail-page.component').then(m => m.RunDetailPageComponent)
  },
  { path: '**', redirectTo: '' }
];
