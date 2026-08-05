import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/runs-page/runs-page.component').then(m => m.RunsPageComponent) },
  {
    path: 'create',
    loadComponent: () =>
      import('./pages/create-run-page/create-run-page.component').then(m => m.CreateRunPageComponent)
  },
  {
    path: 'plans',
    loadComponent: () => import('./pages/plans-page/plans-page.component').then(m => m.PlansPageComponent)
  },
  {
    path: 'plans/:planFile/insights',
    loadComponent: () =>
      import('./pages/plan-insights-page/plan-insights-page.component').then(m => m.PlanInsightsPageComponent)
  },
  {
    path: 'runs/:id',
    loadComponent: () =>
      import('./pages/run-detail-page/run-detail-page.component').then(m => m.RunDetailPageComponent)
  },
  { path: '**', redirectTo: '' }
];
