import { Component, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { interval, startWith, Subscription, switchMap, catchError, of } from 'rxjs';
import { RunnerService } from '../../core/services/runner.service';
import { RunProps, RunSummary } from '../../core/models/runner.models';
import { StartRunFormComponent } from '../../components/start-run-form/start-run-form.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageModule } from 'primeng/message';
import { TabsModule } from 'primeng/tabs';

@Component({
  selector: 'app-runs-page',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    StartRunFormComponent,
    TopbarComponent,
    CardModule,
    TagModule,
    ButtonModule,
    TableModule,
    MessageModule,
    TabsModule
  ],
  templateUrl: './runs-page.component.html',
  styleUrl: './runs-page.component.scss'
})
export class RunsPageComponent implements OnInit, OnDestroy {
  @ViewChild(StartRunFormComponent) startForm?: StartRunFormComponent;

  private readonly runner = inject(RunnerService);
  private readonly router = inject(Router);

  runs = signal<RunSummary[]>([]);
  deletingId = signal<string | null>(null);
  apiOnline = false;
  error = '';
  private pollSub?: Subscription;

  totalRuns = computed(() => this.runs().length);
  succeededRuns = computed(() => this.runs().filter((r) => r.status === 'succeeded').length);
  failedRuns = computed(() =>
    this.runs().filter((r) => r.status === 'failed' || r.status === 'cancelled').length
  );
  runningRuns = computed(() => this.runs().filter((r) => r.status === 'running').length);
  successRate = computed(() => {
    const total = this.totalRuns();
    if (total === 0) return 0;
    return Math.round((this.succeededRuns() / total) * 100);
  });
  latestRun = computed(() => this.runs()[0]);

  ngOnInit(): void {
    this.runner.health().subscribe({
      next: () => (this.apiOnline = true),
      error: () => {
        this.apiOnline = false;
        this.error = 'Runner API is offline. Start it with: npm start';
      }
    });

    this.pollSub = interval(3000)
      .pipe(
        startWith(0),
        switchMap(() =>
          this.runner.listRuns().pipe(catchError(() => of({ runs: [] as RunSummary[] })))
        )
      )
      .subscribe(({ runs }) => {
        this.runs.set(runs);
      });
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  onStartRun(payload: { label: string; props: RunProps }): void {
    this.error = '';
    this.startForm?.setSubmitting(true);

    this.runner.startRun(payload).subscribe({
      next: ({ run }) => {
        this.startForm?.setSubmitting(false);
        void this.router.navigate(['/runs', run.id]);
      },
      error: (err) => {
        this.startForm?.setSubmitting(false);
        this.error = err?.error?.error || err?.message || 'Failed to start run';
      }
    });
  }

  deleteRun(run: RunSummary, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    if (run.status === 'running') {
      this.error = 'Stop the run before deleting it.';
      return;
    }

    const name = run.label || run.id.substring(0, 8);
    const confirmed = confirm(
      `Delete run "${name}"?\n\nThis permanently removes logs, JTL, and HTML report files from disk.`
    );
    if (!confirmed) return;

    this.error = '';
    this.deletingId.set(run.id);
    this.runner.deleteRun(run.id).subscribe({
      next: () => {
        this.deletingId.set(null);
        this.runs.update((list) => list.filter((r) => r.id !== run.id));
      },
      error: (err) => {
        this.deletingId.set(null);
        this.error = err?.error?.error || err?.message || 'Failed to delete run';
      }
    });
  }

  statusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'succeeded':
        return 'success';
      case 'failed':
      case 'cancelled':
        return 'danger';
      case 'running':
        return 'info';
      default:
        return 'secondary';
    }
  }
}
