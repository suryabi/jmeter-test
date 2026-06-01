import { Component, EventEmitter, OnInit, Output, inject } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule
} from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ParameterDef, ParameterGroup, PlanInfo, RunProps } from '../../core/models/runner.models';
import { RunnerService } from '../../core/services/runner.service';
import { formatFieldLabel } from '../../core/utils/format-field-label';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';

@Component({
  selector: 'app-start-run-form',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, ButtonModule, ProgressSpinnerModule, MessageModule, SelectModule],
  templateUrl: './start-run-form.component.html',
  styleUrl: './start-run-form.component.scss'
})
export class StartRunFormComponent implements OnInit {
  @Output() start = new EventEmitter<{ label: string; planFile: string; props: RunProps }>();

  private readonly fb = inject(FormBuilder);
  private readonly runner = inject(RunnerService);

  form: FormGroup = this.fb.group({
    label: this.fb.nonNullable.control('sample-run')
  });

  plans: PlanInfo[] = [];
  selectedPlan: PlanInfo | null = null;
  parameterGroups: ParameterGroup[] = [];
  loading = true;
  loadError = '';
  submitting = false;
  activeGroupId = 'global';

  ngOnInit(): void {
    this.runner.getPlans().subscribe({
      next: ({ plans }) => {
        this.plans = plans;
        this.selectedPlan = plans[0] ?? null;
        this.fetchParameters(this.selectedPlan?.file ?? null);
      },
      error: (err) => {
        this.loadError = err?.error?.error || err?.message || 'Failed to load plans';
        this.loading = false;
      }
    });
  }

  onPlanChange(plan: PlanInfo | null): void {
    this.selectedPlan = plan;
    this.parameterGroups = [];
    this.loadError = '';
    this.loading = true;
    this.fetchParameters(plan?.file ?? null);
  }

  private fetchParameters(planFile: string | null): void {
    this.runner.getParameters(planFile).subscribe({
      next: (schema) => {
        this.parameterGroups = schema.groups;
        this.buildForm(schema.groups);
        if (schema.groups.length > 0) {
          this.activeGroupId = schema.groups[0].id;
        }
        this.loading = false;
      },
      error: (err) => {
        this.loadError = err?.error?.error || err?.message || 'Failed to load parameters';
        this.loading = false;
      }
    });
  }

  setActiveGroup(id: string): void {
    this.activeGroupId = id;
  }

  activeGroup(): ParameterGroup | undefined {
    return this.parameterGroups.find((group) => group.id === this.activeGroupId);
  }

  resetToDefaults(): void {
    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        const control = this.form.get(param.name);
        if (!control) continue;
        control.setValue(this.defaultControlValue(param));
      }
    }
  }

  onSubmit(): void {
    if (this.form.invalid || this.submitting || this.loading) return;

    const raw = this.form.getRawValue() as Record<string, string | boolean>;
    const label = String(raw['label'] ?? 'sample-run');
    const planFile = this.selectedPlan?.file ?? '';
    const props: RunProps = {};

    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        props[param.name] = this.serializeValue(param, raw[param.name]);
      }
    }

    this.start.emit({ label, planFile, props });
  }

  setSubmitting(value: boolean): void {
    this.submitting = value;
  }

  fieldLabel(name: string): string {
    return formatFieldLabel(name);
  }

  groupIconClass(group: ParameterGroup): string {
    const key = `${group.id} ${group.title}`.toLowerCase();
    if (key.includes("global")) return "pi-globe";
    if (key.includes("config")) return "pi-cog";
    if (key.includes("env")) return "pi-server";
    return "pi-folder";
  }

  private buildForm(groups: ParameterGroup[]): void {
    const controls: Record<string, FormControl<string | boolean>> = {
      label: this.fb.nonNullable.control('sample-run')
    };

    for (const group of groups) {
      for (const param of group.parameters) {
        controls[param.name] = this.createControl(param);
      }
    }

    this.form = this.fb.group(controls);
  }

  private createControl(param: ParameterDef): FormControl<string | boolean> {
    return this.fb.nonNullable.control(this.defaultControlValue(param));
  }

  private defaultControlValue(param: ParameterDef): string | boolean {
    if (param.type === 'boolean') {
      return param.defaultValue === 'true';
    }
    return param.defaultValue;
  }

  private serializeValue(param: ParameterDef, value: string | boolean | undefined): string {
    if (param.type === 'boolean') {
      return value ? 'true' : 'false';
    }
    return String(value ?? '');
  }
}
