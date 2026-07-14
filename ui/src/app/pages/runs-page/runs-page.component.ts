import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { interval, startWith, Subscription, switchMap, catchError, of } from 'rxjs';
import { RunnerService } from '../../core/services/runner.service';
import { RunSummary } from '../../core/models/runner.models';
import { confirmDeleteRun } from '../../core/utils/confirm-delete-run';
import { formatDurationMs } from '../../core/utils/format-duration';
import { displayRunSource } from '../../core/utils/display-run-source';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';

type StatusFilter = 'all' | 'succeeded' | 'failed' | 'running';

@Component({
  selector: 'app-runs-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    TopbarComponent,
    TagModule,
    ButtonModule,
    TableModule,
    MessageModule,
    SelectModule,
    InputTextModule
  ],
  templateUrl: './runs-page.component.html',
  styleUrl: './runs-page.component.scss'
})
export class RunsPageComponent implements OnInit, OnDestroy {
  private readonly runner = inject(RunnerService);
  private readonly router = inject(Router);
  private readonly confirmation = inject(ConfirmationService);

  runs = signal<RunSummary[]>([]);
  deletingId = signal<string | null>(null);
  apiOnline = false;
  error = '';
  private pollSub?: Subscription;

  /* Filters */
  searchTerm = signal('');
  statusFilter = signal<StatusFilter>('all');
  planFilter = signal<string | null>(null);

  readonly statusFilterOptions: { label: string; value: StatusFilter }[] = [
    { label: 'All statuses', value: 'all' },
    { label: 'Succeeded', value: 'succeeded' },
    { label: 'Failed', value: 'failed' },
    { label: 'Running', value: 'running' }
  ];

  planFilterOptions = computed(() => {
    const planFiles = [
      ...new Set(this.runs().map((run) => run.planFile).filter((f): f is string => !!f))
    ].sort();
    return [
      { label: 'All plans', value: null as string | null },
      ...planFiles.map((file) => ({ label: file.replace(/\.jmx$/i, ''), value: file as string | null }))
    ];
  });

  filteredRuns = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const status = this.statusFilter();
    const plan = this.planFilter();

    return this.runs().filter((run) => {
      if (status !== 'all') {
        const matchesStatus =
          status === 'failed'
            ? run.status === 'failed' || run.status === 'cancelled'
            : run.status === status;
        if (!matchesStatus) return false;
      }
      if (plan && run.planFile !== plan) return false;
      if (term) {
        const haystack = `${run.label ?? ''} ${run.id}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  });

  hasActiveFilters = computed(
    () => !!this.searchTerm().trim() || this.statusFilter() !== 'all' || !!this.planFilter()
  );

  totalRuns = computed(() => this.runs().length);
  succeededRuns = computed(() => this.runs().filter((r) => r.status === 'succeeded').length);
  failedRuns = computed(() =>
    this.runs().filter((r) => r.status === 'failed' || r.status === 'cancelled').length
  );
  runningRunsList = computed(() => this.runs().filter((r) => r.status === 'running'));
  runningRuns = computed(() => this.runningRunsList().length);
  successRate = computed(() => {
    const total = this.totalRuns();
    if (total === 0) return 0;
    return Math.round((this.succeededRuns() / total) * 100);
  });
  latestRun = computed(() => this.runs()[0]);

  readonly displaySource = displayRunSource;

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

  clearFilters(): void {
    this.searchTerm.set('');
    this.statusFilter.set('all');
    this.planFilter.set(null);
  }

  reuseRunParameters(run: RunSummary, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    void this.router.navigate(['/create'], { queryParams: { fromRun: run.id } });
  }

  runDuration(run: RunSummary): string {
    const startMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startMs)) return '—';

    let endMs: number | null = null;
    if (run.endedAt) {
      endMs = Date.parse(run.endedAt);
    } else if (run.status === 'running') {
      endMs = Date.now();
    }
    if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) return '—';

    const label = formatDurationMs(endMs - startMs);
    return run.status === 'running' ? `${label}…` : label;
  }

  deleteRun(run: RunSummary, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    if (run.status === 'running') {
      this.error = 'Stop the run before deleting it.';
      return;
    }

    const name = run.label || run.id.substring(0, 8);
    confirmDeleteRun(this.confirmation, name, () => {
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
