import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { ActiveRunService } from '../../core/services/active-run.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss'
})
export class TopbarComponent {
  private readonly activeRuns = inject(ActiveRunService);
  private readonly router = inject(Router);

  /** null while the first health check is in flight. */
  readonly apiOnline = this.activeRuns.apiOnline;
  readonly runningRuns = this.activeRuns.runningRuns;
  readonly liveRun = computed(() => this.runningRuns()[0] ?? null);
  readonly liveRunLabel = computed(() => {
    const runs = this.runningRuns();
    if (runs.length === 0) return '';
    if (runs.length === 1) return runs[0].label || 'run in progress';
    return `${runs.length} runs in progress`;
  });

  readonly mobileMenuOpen = signal(false);

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed()
      )
      .subscribe(() => this.mobileMenuOpen.set(false));
  }

  toggleMobileMenu(): void {
    this.mobileMenuOpen.update((open) => !open);
  }

  closeMobileMenu(): void {
    this.mobileMenuOpen.set(false);
  }
}
