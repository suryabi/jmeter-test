import { ChangeDetectorRef, Component, EventEmitter, OnInit, Output, inject } from '@angular/core';
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
import { formatFieldLabel, parameterFieldLabel } from '../../core/utils/format-field-label';
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
  private readonly cdr = inject(ChangeDetectorRef);

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
  showHiddenFields = false;
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
    this.showHiddenFields = false;
    this.loadError = '';
    this.loading = true;
    this.fetchParameters(plan?.file ?? null);
  }

  reloadPlans(): void {
    const previousFile = this.selectedPlan?.file ?? null;
    this.runner.getPlans().subscribe({
      next: ({ plans }) => {
        this.plans = plans;
        const next = plans.find((plan) => plan.file === previousFile) ?? plans[0] ?? null;
        if (next?.file !== this.selectedPlan?.file) {
          this.onPlanChange(next);
        } else {
          this.selectedPlan = next;
        }
      },
      error: (err) => {
        this.loadError = err?.error?.error || err?.message || 'Failed to load plans';
      }
    });
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
        this.ensureActiveGroupVisible();
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
    const visibleGroups = this.visibleParameterGroups();
    return (
      visibleGroups.find((group) => group.id === this.activeGroupId) ?? visibleGroups[0]
    );
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
    return parameterFieldLabel(param);
  }

  isUiHiddenParam(param: ParameterDef): boolean {
    return !!param.hidden || param.kind === 'header';
  }

  isVisibleParam(param: ParameterDef): boolean {
    return this.showHiddenFields || !this.isUiHiddenParam(param);
  }

  visibleParameters(group: ParameterGroup): ParameterDef[] {
    return group.parameters.filter((param) => this.isVisibleParam(param));
  }

  visibleParameterCount(group: ParameterGroup): number {
    return this.visibleParameters(group).length;
  }

  isVisibleGroup(group: ParameterGroup): boolean {
    return this.visibleParameterCount(group) > 0;
  }

  visibleParameterGroups(): ParameterGroup[] {
    return this.parameterGroups.filter((group) => this.isVisibleGroup(group));
  }

  hasHiddenParameters(): boolean {
    return this.parameterGroups.some((group) =>
      group.parameters.some((param) => this.isUiHiddenParam(param))
    );
  }

  onShowHiddenFieldsChange(enabled: boolean): void {
    this.showHiddenFields = enabled;
    this.ensureActiveGroupVisible();
    if (enabled) {
      this.loadDropdownOptions();
    }
  }

  private ensureActiveGroupVisible(): void {
    const visibleGroups = this.visibleParameterGroups();
    if (!visibleGroups.length) {
      return;
    }
    if (!visibleGroups.some((group) => group.id === this.activeGroupId)) {
      this.activeGroupId = visibleGroups[0].id;
    }
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
    const validators = param.required && !param.hidden ? [Validators.required] : [];
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
      if (param) {
        this.form.get(name)?.setValue(this.defaultControlValue(param), { emitEvent: false });
      }
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
          this.applyLoadedOptionsSelection(param, response.options);
        },
        error: (err) => {
          this.fieldOptionsLoading[param.name] = false;
          this.fieldOptionsError[param.name] =
            err?.error?.error || err?.message || 'Failed to load options';
        }
      });
  }

  private applyLoadedOptionsSelection(param: ParameterDef, options: FieldOption[]): void {
    const control = this.form.get(param.name);
    if (!control || !options.length) return;

    const preferred = this.preferredValuesForParam(param, control.value);
    const matched = this.matchOptionValues(options, preferred);
    const previous = this.serializeValue(param, control.value);

    if (param.type === 'multiselect') {
      this.syncMultiselectValue(control as FormControl<string | boolean | string[]>, matched);
      queueMicrotask(() => {
        this.applyDefaultPopulateFirstElement(param, options);
        this.finishLoadedOptionsSelection(param, previous);
        this.cdr.markForCheck();
      });
      return;
    }

    if (matched[0]) {
      control.setValue(matched[0], { emitEvent: false });
    }

    this.applyDefaultPopulateFirstElement(param, options);
    this.finishLoadedOptionsSelection(param, previous);
  }

  private syncMultiselectValue(control: FormControl<string | boolean | string[]>, matched: string[]): void {
    if (!matched.length) return;
    control.setValue([], { emitEvent: false });
    control.setValue([...matched], { emitEvent: false });
  }

  private finishLoadedOptionsSelection(param: ParameterDef, previousSerialized: string): void {
    const control = this.form.get(param.name);
    if (!control) return;

    const next = this.serializeValue(param, control.value);
    if (next !== previousSerialized && this.fieldHasDependents(param.name)) {
      this.onDependencyChanged(param.name);
    }
  }

  private preferredValuesForParam(
    param: ParameterDef,
    current: string | boolean | string[] | undefined
  ): string[] {
    const tokens: string[] = [];
    for (const value of [
      ...this.valuesFromControl(param, current),
      ...this.parseJmxDefaultValues(param)
    ]) {
      if (!tokens.includes(value)) {
        tokens.push(value);
      }
    }
    return tokens;
  }

  private valuesFromControl(
    param: ParameterDef,
    current: string | boolean | string[] | undefined
  ): string[] {
    if (param.type === 'multiselect') {
      return Array.isArray(current)
        ? current.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
    }
    const value = String(current ?? '').trim();
    return value ? [value] : [];
  }

  private parseJmxDefaultValues(param: ParameterDef): string[] {
    const raw = param.defaultValue.trim();
    if (!raw) return [];
    if (param.type === 'multiselect') {
      return raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return [raw];
  }

  private matchOptionValues(options: FieldOption[], preferred: string[]): string[] {
    const seen = new Set<string>();
    const matched: string[] = [];

    for (const token of preferred) {
      const value = this.findOptionValue(options, token);
      if (value && !seen.has(value)) {
        seen.add(value);
        matched.push(value);
      }
    }

    return matched;
  }

  private findOptionValue(options: FieldOption[], token: string): string | undefined {
    const needle = token.trim();
    if (!needle) return undefined;

    const normalized = needle.toLowerCase();
    const hit = options.find(
      (option) =>
        option.value === needle ||
        option.value.toLowerCase() === normalized ||
        option.label.toLowerCase() === normalized ||
        option.label.toLowerCase().replace(/\s+/g, '') === normalized.replace(/\s+/g, '')
    );

    return hit?.value;
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
