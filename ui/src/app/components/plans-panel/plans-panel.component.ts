import { Component, EventEmitter, OnInit, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmationService } from 'primeng/api';
import { RunnerService } from '../../core/services/runner.service';
import { PlanInfo } from '../../core/models/runner.models';
import { confirmDeletePlan } from '../../core/utils/confirm-delete-plan';
import { formatFileSize } from '../../core/utils/format-file-size';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

@Component({
  selector: 'app-plans-panel',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, MessageModule, ProgressSpinnerModule],
  templateUrl: './plans-panel.component.html',
  styleUrl: './plans-panel.component.scss'
})
export class PlansPanelComponent implements OnInit {
  @Output() plansChanged = new EventEmitter<void>();

  private readonly runner = inject(RunnerService);
  private readonly confirmation = inject(ConfirmationService);

  plans = signal<PlanInfo[]>([]);
  loading = signal(true);
  uploading = signal(false);
  deletingFile = signal<string | null>(null);
  error = signal('');

  ngOnInit(): void {
    this.loadPlans();
  }

  reload(): void {
    this.loadPlans();
  }

  onUploadClick(fileInput: HTMLInputElement): void {
    fileInput.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.jmx')) {
      this.error.set('Only .jmx plan files are supported.');
      return;
    }

    this.error.set('');
    this.uploading.set(true);
    this.runner.uploadPlan(file).subscribe({
      next: () => {
        this.uploading.set(false);
        this.loadPlans();
        this.plansChanged.emit();
      },
      error: (err) => {
        this.uploading.set(false);
        this.error.set(err?.error?.error || err?.message || 'Failed to upload plan');
      }
    });
  }

  downloadPlan(plan: PlanInfo): void {
    const link = document.createElement('a');
    link.href = this.runner.planDownloadUrl(plan.file);
    link.download = plan.file;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  deletePlan(plan: PlanInfo, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    confirmDeletePlan(this.confirmation, plan.file, () => {
      this.error.set('');
      this.deletingFile.set(plan.file);
      this.runner.deletePlan(plan.file).subscribe({
        next: () => {
          this.deletingFile.set(null);
          this.loadPlans();
          this.plansChanged.emit();
        },
        error: (err) => {
          this.deletingFile.set(null);
          this.error.set(err?.error?.error || err?.message || 'Failed to delete plan');
        }
      });
    });
  }

  formatSize(bytes: number | null | undefined): string {
    return formatFileSize(bytes);
  }

  private loadPlans(): void {
    this.loading.set(true);
    this.runner.getPlans().subscribe({
      next: ({ plans }) => {
        this.plans.set(plans);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.error || err?.message || 'Failed to load plans');
      }
    });
  }
}
