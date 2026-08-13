import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { interval, startWith, Subscription, switchMap, catchError, of } from 'rxjs';
import { RunnerService } from '../../core/services/runner.service';
import { Schedule } from '../../core/models/runner.models';
import { describeRecurrence } from '../../core/utils/describe-recurrence';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TooltipModule } from 'primeng/tooltip';

@Component({
  selector: 'app-schedules-page',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    TopbarComponent,
    TagModule,
    ButtonModule,
    TableModule,
    MessageModule,
    ProgressSpinnerModule,
    TooltipModule
  ],
  templateUrl: './schedules-page.component.html',
  styleUrl: './schedules-page.component.scss'
})
export class SchedulesPageComponent implements OnInit, OnDestroy {
  private readonly runner = inject(RunnerService);
  private readonly confirmation = inject(ConfirmationService);

  schedules = signal<Schedule[]>([]);
  loading = signal(true);
  apiOnline = false;
  error = '';
  runningNowId = signal<string | null>(null);
  private pollSub?: Subscription;

  readonly describeRecurrence = describeRecurrence;

  ngOnInit(): void {
    this.runner.health().subscribe({
      next: () => (this.apiOnline = true),
      error: () => {
        this.apiOnline = false;
        this.error = 'Runner API is offline. Start it with: npm start';
      }
    });

    this.pollSub = interval(10000)
      .pipe(
        startWith(0),
        switchMap(() =>
          this.runner.listSchedules().pipe(catchError(() => of({ schedules: [] as Schedule[] })))
        )
      )
      .subscribe(({ schedules }) => {
        this.schedules.set(schedules);
        this.loading.set(false);
      });
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  toggleEnabled(schedule: Schedule): void {
    this.error = '';
    this.runner.updateSchedule(schedule.id, { enabled: !schedule.enabled }).subscribe({
      next: ({ schedule: updated }) => {
        this.schedules.update((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Failed to update schedule';
      }
    });
  }

  runNow(schedule: Schedule): void {
    this.error = '';
    this.runningNowId.set(schedule.id);
    this.runner.runScheduleNow(schedule.id).subscribe({
      next: () => {
        this.runningNowId.set(null);
      },
      error: (err) => {
        this.runningNowId.set(null);
        this.error = err?.error?.error || err?.message || 'Failed to run schedule';
      }
    });
  }

  deleteSchedule(schedule: Schedule, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    const name = schedule.label || schedule.id.substring(0, 8);
    this.confirmation.confirm({
      header: 'Delete schedule',
      message: `Delete schedule "${name}"? It will stop firing immediately. Past runs it already created are not affected.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptIcon: 'pi pi-trash',
      rejectIcon: 'pi pi-times',
      acceptButtonProps: { severity: 'danger' },
      rejectButtonProps: { severity: 'secondary' },
      defaultFocus: 'reject',
      dismissableMask: true,
      accept: () => {
        this.error = '';
        this.runner.deleteSchedule(schedule.id).subscribe({
          next: () => {
            this.schedules.update((list) => list.filter((s) => s.id !== schedule.id));
          },
          error: (err) => {
            this.error = err?.error?.error || err?.message || 'Failed to delete schedule';
          }
        });
      }
    });
  }

  statusSeverity(status: string | null): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
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
