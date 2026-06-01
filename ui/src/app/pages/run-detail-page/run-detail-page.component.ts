import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { Subscription, interval, switchMap, catchError, of } from 'rxjs';
import { RunnerService } from '../../core/services/runner.service';
import { confirmDeleteRun } from '../../core/utils/confirm-delete-run';
import {
  RunDetail,
  RunInsights,
  RunSampleRow,
  RunStatus,
  SseCompleteEvent,
  SseLogEvent
} from '../../core/models/runner.models';
import { LogConsoleComponent } from '../../components/log-console/log-console.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { DividerModule } from 'primeng/divider';
import { TableModule } from 'primeng/table';

@Component({
  selector: 'app-run-detail-page',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    LogConsoleComponent,
    TopbarComponent,
    CardModule,
    TagModule,
    ButtonModule,
    MessageModule,
    DividerModule,
    TableModule
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
  reportEmbedUrl: SafeResourceUrl | null = null;
  activeSampleStatus: 'passed' | 'failed' | null = null;
  sampleRows: RunSampleRow[] = [];
  sampleRowsTotal = 0;
  sampleRowsLoading = false;

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

  openReportInNewTab(): void {
    if (!this.hasHtmlReport()) return;
    window.open(this.runner.htmlReportUrl(this.runId), '_blank', 'noopener,noreferrer');
  }

  formatInsightsDuration(insights: RunInsights): string {
    const parts: string[] = [];
    if (insights.durationDays != null) {
      parts.push(`${insights.durationDays} day${insights.durationDays === 1 ? '' : 's'}`);
    }
    if (insights.durationMinutes != null) {
      parts.push(`${insights.durationMinutes} min`);
    }
    return parts.length ? parts.join(' · ') : '—';
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
