import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, interval, of, startWith, switchMap } from 'rxjs';
import { RunnerService } from './runner.service';
import { RunSummary } from '../models/runner.models';

/**
 * App-wide poll for in-flight runs so any page (topbar chip) can show
 * "a run is live" without each page wiring its own poll. Also tracks
 * runner API health so the topbar status survives page navigation.
 */
@Injectable({ providedIn: 'root' })
export class ActiveRunService {
  private readonly runner = inject(RunnerService);

  readonly runningRuns = signal<RunSummary[]>([]);
  /** null = first check still in flight (avoids an "offline" flash on load). */
  readonly apiOnline = signal<boolean | null>(null);

  constructor() {
    interval(5000)
      .pipe(
        startWith(0),
        switchMap(() =>
          this.runner.listRuns().pipe(
            catchError(() => {
              this.apiOnline.set(false);
              return of(null);
            })
          )
        ),
        takeUntilDestroyed()
      )
      .subscribe((result) => {
        if (!result) return;
        this.apiOnline.set(true);
        this.runningRuns.set(result.runs.filter((run) => run.status === 'running'));
      });
  }
}
