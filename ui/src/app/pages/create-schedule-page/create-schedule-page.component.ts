import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { RunnerService } from '../../core/services/runner.service';
import { CreateScheduleRequest, Schedule } from '../../core/models/runner.models';
import { StartRunFormComponent } from '../../components/start-run-form/start-run-form.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

@Component({
  selector: 'app-create-schedule-page',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    TopbarComponent,
    StartRunFormComponent,
    MessageModule,
    ProgressSpinnerModule
  ],
  templateUrl: './create-schedule-page.component.html',
  styleUrl: './create-schedule-page.component.scss'
})
export class CreateSchedulePageComponent implements OnInit {
  private readonly runner = inject(RunnerService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  apiOnline = false;
  error = '';
  loading = false;
  scheduleId: string | null = null;
  schedule: Schedule | null = null;

  ngOnInit(): void {
    this.runner.health().subscribe({
      next: () => (this.apiOnline = true),
      error: () => {
        this.apiOnline = false;
        this.error = 'Runner API is offline. Start it with: npm start';
      }
    });

    this.scheduleId = this.route.snapshot.paramMap.get('id');
    if (this.scheduleId) {
      this.loading = true;
      this.runner.getSchedule(this.scheduleId).subscribe({
        next: ({ schedule }) => {
          this.schedule = schedule;
          this.loading = false;
        },
        error: (err) => {
          this.error = err?.error?.error || err?.message || 'Failed to load schedule';
          this.loading = false;
        }
      });
    }
  }

  onSaveSchedule(payload: CreateScheduleRequest): void {
    this.error = '';
    const save$ = this.scheduleId
      ? this.runner.updateSchedule(this.scheduleId, payload)
      : this.runner.createSchedule(payload);

    save$.subscribe({
      next: () => {
        void this.router.navigate(['/schedules']);
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Failed to save schedule';
      }
    });
  }
}
