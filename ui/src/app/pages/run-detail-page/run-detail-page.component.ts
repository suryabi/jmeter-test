import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { Subscription, interval, switchMap, catchError, of } from 'rxjs';
import { RunnerService } from '../../core/services/runner.service';
import { confirmDeleteRun } from '../../core/utils/confirm-delete-run';
import {
  RunDetail,
  RunInsights,
  RunRequestInsight,
  RunRequestInsightStatus,
  RunSampleRow,
  RunStatus,
  RunStep,
  SseCompleteEvent,
  SseLogEvent
} from '../../core/models/runner.models';
import { formatDurationMs } from '../../core/utils/format-duration';
import { LogConsoleComponent } from '../../components/log-console/log-console.component';
import { RunParametersPanelComponent } from '../../components/run-parameters-panel/run-parameters-panel.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { DividerModule } from 'primeng/divider';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';

@Component({
  selector: 'app-run-detail-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    LogConsoleComponent,
    RunParametersPanelComponent,
    TopbarComponent,
    CardModule,
    TagModule,
    ButtonModule,
    MessageModule,
    DividerModule,
    TableModule,
    SelectModule
  ],
  templateUrl: './run-detail-page.component.html',
  styleUrl: './run-detail-page.component.scss'
})
export class RunDetailPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly confirmation = inject(ConfirmationService);
  readonly runner = inject(RunnerService);

  runId = '';
  run: RunDetail | null = null;
  logLines: string[] = [];
  error = '';
  deleting = false;
  streaming = false;
  showReportEmbed = false;
  showRunParameters = false;
  reportEmbedUrl: SafeResourceUrl | null = null;
  activeSampleStatus: 'passed' | 'failed' | null = null;
  sampleRows: RunSampleRow[] = [];
  sampleRowsTotal = 0;
  sampleRowsLoading = false;
  activeInsightRequestIndex = 1;
  insightRequestOptions: { index: number; label: string }[] = [];

  @ViewChild('samplesTableWrap') samplesTableWrap?: ElementRef<HTMLElement>;

  private pollSub?: Subscription;
  private eventSource?: EventSource;
  /** Raw URL string — only refresh iframe when this changes (avoids reload on every poll). */
  private reportEmbedUrlKey = '';
  /** Avoid refetching JTL samples on every poll when counts are unchanged. */
  private lastSampleSummaryKey = '';
  private samplesPinnedToBottom = true;
  private samplesScrollTarget: HTMLElement | null = null;
  private readonly onSamplesScrollHandler = () => this.onSamplesTableScroll();

  ngOnInit(): void {
    this.runId = this.route.snapshot.paramMap.get('id') || '';
    if (!this.runId) return;

    this.loadRun(() => {
      if (this.run?.status === 'running') {
        this.connectLogStream();
      }
    });
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.closeStream();
    this.unbindSamplesScrollListener();
  }

  loadRun(afterLoad?: () => void): void {
    this.runner.getRun(this.runId, 200).subscribe({
      next: ({ run }) => {
        this.applyRunUpdate(run);
        if (this.logLines.length === 0 && run.logTail?.length) {
          this.logLines = [...run.logTail];
        }
        afterLoad?.();
      },
      error: (err) => {
        this.error = err?.error?.error || 'Run not found';
      }
    });
  }

  startPolling(): void {
    this.pollSub = interval(2500)
      .pipe(switchMap(() => this.runner.getRun(this.runId, 30).pipe(catchError(() => of(null)))))
      .subscribe((result) => {
        if (!result) return;
        this.applyRunUpdate(result.run);
        if (result.run.status !== 'running') {
          this.closeStream();
          this.stopPolling();
        }
      });
  }

  connectLogStream(): void {
    this.closeStream();
    this.streaming = true;

    const es = new EventSource(this.runner.logStreamUrl(this.runId));
    this.eventSource = es;

    es.addEventListener('log', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseLogEvent;
        if (data.line) {
          const prefix = data.source === 'launcher' ? '[launcher] ' : '';
          this.logLines = [...this.logLines, `${prefix}${data.line}`];
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('complete', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseCompleteEvent;
        if (this.run) {
          this.run = {
            ...this.run,
            status: data.status,
            exitCode: data.exitCode,
            summary: data.summary,
            insights: data.insights
          };
        }
      } catch {
        // ignore
      }
      this.streaming = false;
      this.closeStream();
      this.loadRun();
    });

    es.onerror = () => {
      this.streaming = false;
      this.closeStream();
    };
  }

  stopRun(): void {
    this.runner.stopRun(this.runId).subscribe({
      next: () => this.loadRun(),
      error: (err) => {
        this.error = err?.error?.error || 'Failed to stop run';
      }
    });
  }

  deleteRun(): void {
    if (!this.run || this.deleting) return;

    if (this.run.status === 'running') {
      this.error = 'Stop the run before deleting it.';
      return;
    }

    const name = this.run.label || this.run.id.substring(0, 8);
    confirmDeleteRun(this.confirmation, name, () => {
      this.error = '';
      this.deleting = true;
      this.closeStream();

      this.runner.deleteRun(this.runId).subscribe({
        next: () => {
          this.deleting = false;
          void this.router.navigate(['/']);
        },
        error: (err) => {
          this.deleting = false;
          this.error = err?.error?.error || err?.message || 'Failed to delete run';
        }
      });
    });
  }

  clearLogs(): void {
    this.logLines = [];
  }

  selectSampleStatus(status: 'passed' | 'failed'): void {
    this.activeSampleStatus = this.activeSampleStatus === status ? null : status;
    this.lastSampleSummaryKey = '';
    if (!this.activeSampleStatus) {
      this.unbindSamplesScrollListener();
      this.sampleRows = [];
      this.sampleRowsTotal = 0;
      return;
    }
    this.samplesPinnedToBottom = true;
    this.loadSampleRows(this.activeSampleStatus);
  }

  onSamplesTableScroll(): void {
    const el = this.getSamplesScrollElement();
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.samplesPinnedToBottom = distanceFromBottom <= 48;
  }

  isSampleStatusActive(status: 'passed' | 'failed'): boolean {
    return this.activeSampleStatus === status;
  }

  hasHtmlReport(): boolean {
    return !!this.run?.artifacts?.htmlReportUrl;
  }

  toggleReportEmbed(): void {
    this.showReportEmbed = !this.showReportEmbed;
    if (this.showReportEmbed) {
      this.ensureReportEmbedUrl();
    }
  }

  toggleRunParameters(): void {
    this.showRunParameters = !this.showRunParameters;
  }

  openReportInNewTab(): void {
    if (!this.hasHtmlReport()) return;
    window.open(this.runner.htmlReportUrl(this.runId), '_blank', 'noopener,noreferrer');
  }

  formatInsightsDuration(insights: RunInsights): string {
    return this.formatRequestDuration(insights.durationDays, insights.durationMinutes);
  }

  formatRequestDuration(durationDays: number | null, durationMinutes: number | null): string {
    const parts: string[] = [];
    if (durationDays != null) {
      parts.push(`${durationDays} day${durationDays === 1 ? '' : 's'}`);
    }
    if (durationMinutes != null) {
      parts.push(`${durationMinutes} min`);
    }
    return parts.length ? parts.join(' · ') : '—';
  }

  formatRequestTime(request: RunRequestInsight): string {
    if (!request.startTime) return '—';
    return `${request.startTime} – ${request.endTime || '?'}`;
  }

  requestStatusLabel(status: RunRequestInsightStatus): string {
    switch (status) {
      case 'created':
        return 'Created';
      case 'skipped':
        return 'Skipped';
      case 'failed':
        return 'Failed';
      default:
        return 'Started';
    }
  }

  requestStatusSeverity(
    status: RunRequestInsightStatus
  ): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    switch (status) {
      case 'created':
        return 'success';
      case 'failed':
        return 'danger';
      case 'skipped':
        return 'warn';
      default:
        return 'secondary';
    }
  }

  get selectedInsightRequest(): RunRequestInsight | null {
    if (!this.run) return null;
    return (
      this.run.insights.requests.find((request) => request.index === this.activeInsightRequestIndex) ??
      null
    );
  }

  insightRequestOptionLabel(request: RunRequestInsight): string {
    const parts = [`Request ${request.index}/${request.total}`];
    const name = request.customerName?.trim();
    if (name) parts.push(name);
    parts.push(this.requestStatusLabel(request.status));
    return parts.join(' · ');
  }

  stepStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    switch (status) {
      case 'success':
        return 'success';
      case 'failed':
        return 'danger';
      case 'warn':
        return 'warn';
      case 'info':
        return 'info';
      default:
        return 'secondary';
    }
  }

  /** Wall-clock time for the JMeter process (startedAt → endedAt or now while running). */
  formatRunExecutionDuration(run: RunDetail): string {
    const startMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startMs)) return '—';

    let endMs: number | null = null;
    if (run.endedAt) {
      endMs = Date.parse(run.endedAt);
    } else if (run.status === 'running') {
      endMs = Date.now();
    }
    if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) {
      return '—';
    }
    const label = formatDurationMs(endMs - startMs);
    return run.status === 'running' && !run.endedAt ? `${label} (ongoing)` : label;
  }

  /** Elapsed time until the next step, run end, or now (for the last step while running). */
  formatStepDuration(steps: RunStep[], index: number): string {
    const step = steps[index];
    if (!step?.at) return '—';

    const startMs = Date.parse(step.at);
    if (!Number.isFinite(startMs)) return '—';

    let endMs: number | null = null;
    const next = steps[index + 1];
    if (next?.at) {
      endMs = Date.parse(next.at);
    } else if (this.run?.endedAt) {
      endMs = Date.parse(this.run.endedAt);
    } else if (this.run?.status === 'running') {
      endMs = Date.now();
    }

    if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) return '—';
    const label = formatDurationMs(endMs - startMs);
    const isLast = index === steps.length - 1;
    if (isLast && this.run?.status === 'running' && !this.run.endedAt) {
      return `${label} (ongoing)`;
    }
    return label;
  }

  statusSeverity(status: RunStatus | undefined): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
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

  private closeStream(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = undefined;
  }

  private applyRunUpdate(run: RunDetail): void {
    this.run = run;
    this.syncActiveInsightRequest(run.insights.requests);
    if (this.hasHtmlReport()) {
      this.ensureReportEmbedUrl();
    } else {
      this.clearReportEmbedUrl();
    }

    if (this.activeSampleStatus) {
      const summaryKey = this.sampleSummaryKey(run);
      if (summaryKey !== this.lastSampleSummaryKey) {
        this.lastSampleSummaryKey = summaryKey;
        this.loadSampleRows(this.activeSampleStatus, { silent: this.sampleRows.length > 0 });
      }
    }
  }

  private syncActiveInsightRequest(requests: RunRequestInsight[]): void {
    this.insightRequestOptions = requests.map((request) => ({
      index: request.index,
      label: this.insightRequestOptionLabel(request)
    }));

    if (!requests.length) {
      this.activeInsightRequestIndex = 1;
      return;
    }

    const stillValid = requests.some((request) => request.index === this.activeInsightRequestIndex);
    if (stillValid) return;

    const preferred =
      requests.find((request) => request.status === 'created') ??
      requests.find((request) => request.status === 'failed') ??
      requests[0];
    this.activeInsightRequestIndex = preferred.index;
  }

  private sampleSummaryKey(run: RunDetail): string {
    const s = run.summary;
    return `${run.status}:${s?.samples ?? 0}:${s?.success ?? 0}:${s?.failed ?? 0}`;
  }

  private getSamplesScrollElement(): HTMLElement | null {
    const root = this.samplesTableWrap?.nativeElement;
    if (!root) return null;
    return (
      root.querySelector<HTMLElement>('.p-datatable-scrollable-body') ??
      root.querySelector<HTMLElement>('.p-virtualscroller') ??
      root.querySelector<HTMLElement>('.p-datatable-table-container')
    );
  }

  private ensureReportEmbedUrl(): void {
    const url = this.runner.htmlReportUrl(this.runId);
    if (url === this.reportEmbedUrlKey) return;
    this.reportEmbedUrlKey = url;
    this.reportEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private clearReportEmbedUrl(): void {
    this.reportEmbedUrlKey = '';
    this.reportEmbedUrl = null;
    this.showReportEmbed = false;
  }

  private loadSampleRows(status: 'passed' | 'failed', options: { silent?: boolean } = {}): void {
    if (!this.run) return;

    const scrollEl = this.getSamplesScrollElement();
    const shouldFollow = this.samplesPinnedToBottom;
    const savedScrollTop =
      options.silent && scrollEl && !shouldFollow ? scrollEl.scrollTop : null;

    if (!options.silent) {
      this.sampleRowsLoading = true;
    }

    this.runner.getRunSamples(this.run.id, status, 0, 300).subscribe({
      next: (res) => {
        if (!options.silent) {
          this.sampleRowsLoading = false;
        }
        if (this.activeSampleStatus !== status) return;
        this.sampleRows = res.rows;
        this.sampleRowsTotal = res.total;
        if (this.run) {
          this.lastSampleSummaryKey = this.sampleSummaryKey(this.run);
        }

        queueMicrotask(() => {
          this.bindSamplesScrollListener();
          if (shouldFollow) {
            this.scrollSamplesToBottom();
          } else if (savedScrollTop != null) {
            requestAnimationFrame(() => {
              const el = this.getSamplesScrollElement();
              if (el) el.scrollTop = savedScrollTop;
            });
          }
        });
      },
      error: () => {
        if (!options.silent) {
          this.sampleRowsLoading = false;
          this.sampleRows = [];
          this.sampleRowsTotal = 0;
        }
      }
    });
  }

  private scrollSamplesToBottom(): void {
    const el = this.getSamplesScrollElement();
    if (el) {
      el.scrollTop = el.scrollHeight;
      this.samplesPinnedToBottom = true;
    }
  }

  private bindSamplesScrollListener(): void {
    const el = this.getSamplesScrollElement();
    if (!el || el === this.samplesScrollTarget) return;
    this.unbindSamplesScrollListener();
    this.samplesScrollTarget = el;
    el.addEventListener('scroll', this.onSamplesScrollHandler, { passive: true });
  }

  private unbindSamplesScrollListener(): void {
    if (this.samplesScrollTarget) {
      this.samplesScrollTarget.removeEventListener('scroll', this.onSamplesScrollHandler);
      this.samplesScrollTarget = null;
    }
  }
}
