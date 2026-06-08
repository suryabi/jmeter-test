import { Component, EventEmitter, OnInit, Output, inject } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { CommonModule } from '@angular/common';
import {
  FieldOption,
  ParameterDef,
  ParameterGroup,
  PlanInfo,
  RunProps
} from '../../core/models/runner.models';
import { RunnerService } from '../../core/services/runner.service';
import { formatFieldLabel } from '../../core/utils/format-field-label';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { MultiSelectModule } from 'primeng/multiselect';

@Component({
  selector: 'app-start-run-form',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    ProgressSpinnerModule,
    MessageModule,
    SelectModule,
    DatePickerModule,
    InputTextModule,
    CheckboxModule,
    MultiSelectModule
  ],
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
  fieldOptions: Record<string, FieldOption[]> = {};
  fieldOptionsLoading: Record<string, boolean> = {};
  fieldOptionsError: Record<string, string> = {};

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
        this.fieldOptions = {};
        this.fieldOptionsLoading = {};
        this.fieldOptionsError = {};
        this.buildForm(schema.groups);
        this.loadDropdownOptions();
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
        control.setValue(this.defaultControlValue(param), { emitEvent: false });
      }
    }
    this.loadDropdownOptions();
  }

  onDropdownChange(fieldName: string): void {
    queueMicrotask(() => {
      if (this.fieldHasDependents(fieldName)) {
        this.onDependencyChanged(fieldName);
      }
    });
  }

  dropdownOptions(param: ParameterDef): FieldOption[] {
    if (!this.dependenciesReady(param)) {
      return [];
    }
    return this.fieldOptions[param.name] || [];
  }

  dependenciesReady(param: ParameterDef): boolean {
    const deps = param.apiConfig?.depends ?? [];
    if (!deps.length) return true;

    const raw = this.form.getRawValue() as Record<string, string | boolean>;
    return deps.every((dep) => String(raw[dep] ?? '').trim());
  }

  dropdownPlaceholder(param: ParameterDef): string {
    if (this.dependenciesReady(param)) {
      return 'Select an option';
    }

    const labels = (param.apiConfig?.depends ?? []).map((dep) => {
      const parent = this.findParam(dep);
      return parent ? this.fieldLabel(parent) : formatFieldLabel(dep);
    });

    return `Select ${labels.join(' and ')} first`;
  }

  onSubmit(): void {
    if (this.form.invalid || this.submitting || this.loading) return;

    const raw = this.form.getRawValue() as Record<string, string | boolean | string[]>;
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

  fieldLabel(param: ParameterDef): string {
    if (param.kind === 'header' && param.headerName) {
      return param.headerName;
    }
    return formatFieldLabel(param.name);
  }

  groupIconClass(group: ParameterGroup): string {
    const key = `${group.id} ${group.title}`.toLowerCase();
    if (key.includes("header")) return "pi-arrow-right-arrow-left";
    if (key.includes("global")) return "pi-globe";
    if (key.includes("config")) return "pi-cog";
    if (key.includes("env")) return "pi-server";
    return "pi-folder";
  }

  private buildForm(groups: ParameterGroup[]): void {
    const controls: Record<string, FormControl<string | boolean | string[]>> = {
      label: this.fb.nonNullable.control('sample-run')
    };

    for (const group of groups) {
      for (const param of group.parameters) {
        controls[param.name] = this.createControl(param);
      }
    }

    this.form = this.fb.group(controls);
  }

  private createControl(param: ParameterDef): FormControl<string | boolean | string[]> {
    const validators = param.required ? [Validators.required] : [];
    return this.fb.nonNullable.control(this.defaultControlValue(param), validators);
  }

  private defaultControlValue(param: ParameterDef): string | boolean | string[] {
    if (param.type === 'boolean') {
      return param.defaultValue === 'true';
    }
    if (param.type === 'multiselect') {
      return param.defaultValue
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return param.defaultValue;
  }

  private serializeValue(
    param: ParameterDef,
    value: string | boolean | string[] | undefined
  ): string {
    if (param.type === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (param.type === 'multiselect') {
      const values = Array.isArray(value)
        ? value
        : String(value ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
      return values.join(',');
    }
    return String(value ?? '');
  }

  private collectPropsForApi(): RunProps {
    const raw = this.form.getRawValue() as Record<string, string | boolean | string[]>;
    const props: RunProps = {};

    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        props[param.name] = this.serializeValue(param, raw[param.name]);
      }
    }

    return props;
  }

  private findParam(name: string): ParameterDef | undefined {
    for (const group of this.parameterGroups) {
      const param = group.parameters.find((entry) => entry.name === name);
      if (param) return param;
    }
    return undefined;
  }

  private isApiOptionsField(param: ParameterDef): boolean {
    return (param.type === 'dropdown' || param.type === 'multiselect') && !!param.apiConfig;
  }

  private allApiDropdownParams(): ParameterDef[] {
    return this.parameterGroups.flatMap((group) =>
      group.parameters.filter((param) => this.isApiOptionsField(param))
    );
  }

  private fieldHasDependents(fieldName: string): boolean {
    return this.allApiDropdownParams().some((param) =>
      param.apiConfig?.depends?.includes(fieldName)
    );
  }

  private onDependencyChanged(changedField: string): void {
    const dependents = this.collectDependents(changedField);

    for (const name of dependents) {
      const param = this.findParam(name);
      const cleared = param?.type === 'multiselect' ? [] : '';
      this.form.get(name)?.setValue(cleared, { emitEvent: false });
      this.fieldOptions[name] = [];
      this.fieldOptionsError[name] = '';
      this.fieldOptionsLoading[name] = false;
    }

    for (const name of dependents) {
      const param = this.findParam(name);
      if (param) {
        this.loadFieldOptions(param);
      }
    }
  }

  private collectDependents(fieldName: string): string[] {
    const dependents: string[] = [];
    const queue = [fieldName];
    const seen = new Set<string>();

    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;

      for (const param of this.allApiDropdownParams()) {
        if (!param.apiConfig?.depends?.includes(current)) continue;
        if (seen.has(param.name)) continue;
        seen.add(param.name);
        dependents.push(param.name);
        queue.push(param.name);
      }
    }

    return dependents;
  }

  private loadDropdownOptions(): void {
    for (const param of this.allApiDropdownParams()) {
      this.loadFieldOptions(param);
    }
  }

  private loadFieldOptions(param: ParameterDef): void {
    if (!this.isApiOptionsField(param)) return;

    if (!this.dependenciesReady(param)) {
      this.fieldOptions[param.name] = [];
      this.fieldOptionsLoading[param.name] = false;
      this.fieldOptionsError[param.name] = '';
      return;
    }

    this.fieldOptionsLoading[param.name] = true;
    this.fieldOptionsError[param.name] = '';

    this.runner
      .getFieldOptions({
        planFile: this.selectedPlan?.file,
        field: param.name,
        props: this.collectPropsForApi()
      })
      .subscribe({
        next: (response) => {
          this.fieldOptions[param.name] = response.options;
          this.fieldOptionsLoading[param.name] = false;
          this.applyDefaultPopulateFirstElement(param, response.options);
        },
        error: (err) => {
          this.fieldOptionsLoading[param.name] = false;
          this.fieldOptionsError[param.name] =
            err?.error?.error || err?.message || 'Failed to load options';
        }
      });
  }

  private applyDefaultPopulateFirstElement(param: ParameterDef, options: FieldOption[]): void {
    if (!param.apiConfig?.defaultPopulateFirstElement || !options.length) return;

    const control = this.form.get(param.name);
    if (!control) return;

    const current = control.value;
    const hasValue =
      param.type === 'multiselect'
        ? Array.isArray(current) && current.length > 0
        : String(current ?? '').trim() !== '';

    const valueIsValid =
      param.type === 'multiselect'
        ? Array.isArray(current) &&
          current.length > 0 &&
          current.every((entry) => options.some((option) => option.value === entry))
        : options.some((option) => option.value === String(current ?? ''));

    if (hasValue && valueIsValid) return;

    const firstValue = options[0]?.value;
    if (!firstValue) return;

    const nextValue = param.type === 'multiselect' ? [firstValue] : firstValue;
    control.setValue(nextValue);
    this.onDropdownChange(param.name);
  }
}
