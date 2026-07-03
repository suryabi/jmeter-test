import { AfterViewInit, Component, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RunnerService } from '../../core/services/runner.service';
import { RunProps, RunSummary } from '../../core/models/runner.models';
import { StartRunFormComponent } from '../../components/start-run-form/start-run-form.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-create-run-page',
  standalone: true,
  imports: [CommonModule, TopbarComponent, StartRunFormComponent, MessageModule],
  templateUrl: './create-run-page.component.html',
  styleUrl: './create-run-page.component.scss'
})
export class CreateRunPageComponent implements OnInit, AfterViewInit {
  @ViewChild(StartRunFormComponent) startForm?: StartRunFormComponent;

  private readonly runner = inject(RunnerService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  apiOnline = false;
  error = '';
  priorRuns: RunSummary[] = [];
  private viewReady = false;
  private pendingFromRun: RunSummary | null = null;

  ngOnInit(): void {
    this.runner.health().subscribe({
      next: () => (this.apiOnline = true),
      error: () => {
        this.apiOnline = false;
        this.error = 'Runner API is offline. Start it with: npm start';
      }
    });

    this.runner.listRuns().subscribe({
      next: ({ runs }) => {
        this.priorRuns = runs;
        this.resolveFromRunParam();
      },
      error: () => {
        this.priorRuns = [];
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.applyPendingFromRun();
  }

  onStartRun(payload: { label: string; planFile: string; props: RunProps }): void {
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

  private resolveFromRunParam(): void {
    const fromRun = this.route.snapshot.queryParamMap.get('fromRun');
    if (!fromRun) return;

    const run = this.priorRuns.find((entry) => entry.id === fromRun);
    if (!run) {
      this.error = `Run "${fromRun}" was not found; starting from plan defaults.`;
      return;
    }
    this.pendingFromRun = run;
    this.applyPendingFromRun();
  }

  private applyPendingFromRun(): void {
    if (!this.viewReady || !this.pendingFromRun) return;
    const run = this.pendingFromRun;
    this.pendingFromRun = null;
    queueMicrotask(() => this.startForm?.applyPropsFromRun(run));
  }
}
