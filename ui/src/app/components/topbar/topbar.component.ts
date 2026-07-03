import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
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
}
