import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  inject
} from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import {
  FieldOption,
  ParameterDef,
  ParameterGroup,
  PlanInfo,
  RunProps,
  RunSummary,
  Schedule,
  ScheduleRecurrence,
  ScheduleRule
} from '../../core/models/runner.models';
import { RunnerService } from '../../core/services/runner.service';
import { formatFieldLabel, parameterFieldLabel } from '../../core/utils/format-field-label';
import {
  localTimeToUtcTimeValue,
  pickerDateToTimeString,
  pickerDateToUtcInstant,
  timeStringToPickerDate,
  utcInstantToPickerDate,
  utcTimeToLocalTimeValue
} from '../../core/utils/describe-recurrence';
import { parameterFieldColumnClass } from '../../core/utils/parameter-grid-column';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { MultiSelectModule } from 'primeng/multiselect';
import { RadioButtonModule } from 'primeng/radiobutton';

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
    MultiSelectModule,
    RadioButtonModule
  ],
  templateUrl: './start-run-form.component.html',
  styleUrl: './start-run-form.component.scss'
})
export class StartRunFormComponent implements OnInit, OnDestroy {
  @Input() priorRuns: RunSummary[] = [];
  @Input() mode: 'run' | 'schedule' = 'run';
  /** Schedule mode only: an existing schedule to pre-fill for editing. */
  @Input() initialSchedule: Schedule | null = null;
  @Output() start = new EventEmitter<{ label: string; planFile: string; props: RunProps }>();
  @Output() scheduleSave = new EventEmitter<{
    label: string;
    planFile: string;
    baseProps: RunProps;
    rules: ScheduleRule[];
    recurrence: ScheduleRecurrence;
  }>();

  /** Schedule mode only: date-type param name -> "today + N days" offset. */
  dateRules: Record<string, number | null> = {};
  recurrenceType: 'once' | 'daily' | 'cron' = 'daily';
  /** UTC time, entered and displayed as-is (no local-timezone conversion). */
  recurrenceTime = '00:00';
  /** recurrenceTime as a timeOnly-picker Date — kept in sync explicitly (see recurrenceOnceAtLocal note). */
  recurrenceTimeUtcPickerDate: Date = timeStringToPickerDate('00:00');
  /** recurrenceTime converted to local, as a timeOnly-picker Date. */
  recurrenceTimeLocalPickerDate: Date = timeStringToPickerDate(utcTimeToLocalTimeValue('00:00'));
  /** UTC date/time, "dressed" as a picker-local Date — see utcInstantToPickerDate. */
  recurrenceOnceAt: Date | null = null;
  /** Same instant as recurrenceOnceAt, as a real local Date — kept in sync explicitly (not recomputed per CD cycle) to avoid feeding the datepicker a new object reference on every check. */
  recurrenceOnceAtLocal: Date | null = null;
  recurrenceCronExpression = '';
  recurrenceCronTouched = false;
  cronPreview: string | null = null;
  cronPreviewLoading = false;
  cronPreviewError = '';

  onRecurrenceTypeChange(type: 'once' | 'daily' | 'cron'): void {
    this.recurrenceType = type;
    if (type === 'once' && this.recurrenceOnceInPast()) {
      const defaultInstant = new Date();
      defaultInstant.setUTCHours(defaultInstant.getUTCHours() + 1, 0, 0, 0);
      this.recurrenceOnceAt = utcInstantToPickerDate(defaultInstant);
      this.recurrenceOnceAtLocal = defaultInstant;
    }
    if (type === 'cron') {
      this.recurrenceCronTouched = false;
      this.cronExpressionChanges.next(this.recurrenceCronExpression);
    }
  }

  onRecurrenceCronBlur(): void {
    this.recurrenceCronTouched = true;
  }

  onCronExpressionChange(value: string): void {
    this.recurrenceCronExpression = value;
    this.cronExpressionChanges.next(value);
  }

  recurrenceOnceInPast(): boolean {
    if (this.recurrenceType !== 'once') return false;
    if (!this.recurrenceOnceAt) return true;
    return pickerDateToUtcInstant(this.recurrenceOnceAt) <= new Date();
  }

  recurrenceCronMissing(): boolean {
    return this.recurrenceType === 'cron' && !this.recurrenceCronExpression.trim();
  }

  /** UTC time picker changed directly. */
  onRecurrenceTimeUtcPickerChange(value: Date | null): void {
    const time = value ? pickerDateToTimeString(value) : '00:00';
    this.recurrenceTime = time;
    this.recurrenceTimeUtcPickerDate = value ?? timeStringToPickerDate(time);
    this.recurrenceTimeLocalPickerDate = timeStringToPickerDate(utcTimeToLocalTimeValue(time));
  }

  /** Local time picker changed — convert back to the UTC source of truth. */
  onRecurrenceTimeLocalPickerChange(value: Date | null): void {
    const localTime = value ? pickerDateToTimeString(value) : '00:00';
    this.recurrenceTime = localTimeToUtcTimeValue(localTime);
    this.recurrenceTimeLocalPickerDate = value ?? timeStringToPickerDate(localTime);
    this.recurrenceTimeUtcPickerDate = timeStringToPickerDate(this.recurrenceTime);
  }

  /** Recompute both time pickers from recurrenceTime (call after setting it directly, e.g. from a loaded schedule). */
  private syncTimePickers(): void {
    this.recurrenceTimeUtcPickerDate = timeStringToPickerDate(this.recurrenceTime);
    this.recurrenceTimeLocalPickerDate = timeStringToPickerDate(
      utcTimeToLocalTimeValue(this.recurrenceTime)
    );
  }

  /** e.g. "Aug 14, 2026, 9:00 AM" — the UTC date/time the user picked, shown in their own local time. */
  recurrenceOnceLocalLabel(): string {
    if (!this.recurrenceOnceAt) return '';
    return pickerDateToUtcInstant(this.recurrenceOnceAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  /** UTC datepicker changed directly. */
  onRecurrenceOnceUtcChange(value: Date | null): void {
    this.recurrenceOnceAt = value;
    this.recurrenceOnceAtLocal = value ? pickerDateToUtcInstant(value) : null;
  }

  /** Local datepicker changed — re-dress as the UTC picker value. */
  onRecurrenceOnceLocalChange(value: Date | null): void {
    this.recurrenceOnceAtLocal = value;
    this.recurrenceOnceAt = value ? utcInstantToPickerDate(value) : null;
  }

  private readonly fb = inject(FormBuilder);
  private readonly runner = inject(RunnerService);
  private readonly cdr = inject(ChangeDetectorRef);
  private enableIfSub?: Subscription;
  private readonly cronExpressionChanges = new Subject<string>();
  private cronPreviewSub?: Subscription;

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
  selectedPriorRunId: string | null = null;
  propsLoadNotice = '';
  private pendingPropsFromRun: RunProps | null = null;
  private pendingPropsSourceLabel = '';
  /** Set when applyPropsFromRun is called before plans/parameters finished loading. */
  private pendingApplyRun: RunSummary | null = null;
  private appliedInitialSchedule = false;

  ngOnInit(): void {
    this.runner.getPlans().subscribe({
      next: ({ plans }) => {
        this.plans = plans;
        this.selectedPlan = this.initialSchedule
          ? plans.find((plan) => plan.file === this.initialSchedule!.planFile) ?? plans[0] ?? null
          : plans[0] ?? null;
        this.fetchParameters(this.selectedPlan?.file ?? null);
      },
      error: (err) => {
        this.loadError = err?.error?.error || err?.message || 'Failed to load plans';
        this.loading = false;
      }
    });

    this.cronPreviewSub = this.cronExpressionChanges
      .pipe(
        debounceTime(500),
        distinctUntilChanged(),
        switchMap((expression) => {
          if (!expression.trim()) {
            this.cronPreviewLoading = false;
            return of({ nextRunAt: null, error: '' });
          }
          this.cronPreviewLoading = true;
          return this.runner.previewRecurrence({ type: 'cron', expression }).pipe(
            map((res) => ({ nextRunAt: res.nextRunAt, error: '' })),
            catchError((err) =>
              of({ nextRunAt: null, error: err?.error?.error || 'Invalid cron expression' })
            )
          );
        })
      )
      .subscribe(({ nextRunAt, error }) => {
        this.cronPreviewLoading = false;
        this.cronPreview = nextRunAt;
        this.cronPreviewError = error;
        this.cdr.markForCheck();
      });
  }

  ngOnDestroy(): void {
    this.enableIfSub?.unsubscribe();
    this.cronPreviewSub?.unsubscribe();
  }

  onPlanChange(plan: PlanInfo | null): void {
    if (!this.pendingPropsFromRun) {
      this.selectedPriorRunId = null;
      this.propsLoadNotice = '';
    }
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
        this.dateRules = {};
        this.buildForm(schema.groups);
        this.loadDropdownOptions();
        if (schema.groups.length > 0) {
          this.activeGroupId = schema.groups[0].id;
        }
        this.ensureActiveGroupVisible();
        this.loading = false;
        this.finishPendingPropsLoad();
        if (this.pendingApplyRun) {
          const run = this.pendingApplyRun;
          this.pendingApplyRun = null;
          this.applyPropsFromRun(run);
        }
        if (this.initialSchedule && !this.appliedInitialSchedule) {
          this.appliedInitialSchedule = true;
          this.applyScheduleToForm(this.initialSchedule);
        }
      },
      error: (err) => {
        this.loadError = err?.error?.error || err?.message || 'Failed to load parameters';
        this.loading = false;
        this.pendingPropsFromRun = null;
        this.pendingPropsSourceLabel = '';
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
    this.selectedPriorRunId = null;
    this.propsLoadNotice = '';
    this.pendingPropsFromRun = null;
    this.pendingPropsSourceLabel = '';
    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        const control = this.form.get(param.name);
        if (!control) continue;
        control.setValue(this.defaultControlValue(param), { emitEvent: false });
      }
    }
    this.loadDropdownOptions();
    this.syncEnableIfStates();
  }

  priorRunOptions(): { label: string; value: string | null; run?: RunSummary }[] {
    const options = this.priorRuns.map((run) => ({
      label: this.formatPriorRunLabel(run),
      value: run.id,
      run
    }));
    return [{ label: '— Use plan defaults —', value: null }, ...options];
  }

  onPriorRunSelected(runId: string | null): void {
    this.selectedPriorRunId = runId;
    if (!runId) {
      this.propsLoadNotice = '';
      return;
    }
    const run = this.priorRuns.find((entry) => entry.id === runId);
    if (run) {
      this.applyPropsFromRun(run);
    }
  }

  /** Pre-fill the form from a previous run (dropdown, Reuse buttons, or ?fromRun=). */
  applyPropsFromRun(run: RunSummary): void {
    if (this.loading) {
      this.pendingApplyRun = run;
      return;
    }
    this.selectedPriorRunId = run.id;
    this.propsLoadNotice = '';
    this.pendingPropsFromRun = null;
    this.pendingPropsSourceLabel = '';

    const props = run.props ?? {};
    const sourceLabel = run.label?.trim() || run.id.substring(0, 8);
    const rerunLabel = this.suggestRerunLabel(sourceLabel);
    this.form.get('label')?.setValue(rerunLabel, { emitEvent: false });

    const planFile = run.planFile?.trim();
    if (planFile && this.selectedPlan?.file !== planFile) {
      const plan = this.plans.find((entry) => entry.file === planFile);
      if (plan) {
        this.pendingPropsFromRun = props;
        this.pendingPropsSourceLabel = sourceLabel;
        this.selectedPlan = plan;
        this.parameterGroups = [];
        this.showHiddenFields = false;
        this.loadError = '';
        this.loading = true;
        this.fetchParameters(plan.file);
        return;
      }
      this.propsLoadNotice = `Loaded parameters from “${sourceLabel}”; plan “${planFile}” is not available — using ${this.selectedPlan?.file ?? 'current plan'}.`;
    }

    this.applyPropsToForm(props);
    this.loadDropdownOptions();
    if (!this.propsLoadNotice) {
      this.propsLoadNotice = `Loaded parameters from “${sourceLabel}”. Review fields, then start the run.`;
    }
    this.syncEnableIfStates();
    this.cdr.markForCheck();
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
    const options = this.fieldOptions[param.name] || [];
    if (param.type === 'dropdown' && !param.required) {
      return [{ label: 'Select an option', value: null }, ...options];
    }
    return options;
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

  onFormSubmit(): void {
    if (this.mode === 'schedule') {
      this.onSubmitSchedule();
    } else {
      this.onSubmit();
    }
  }

  isDateRuleEnabled(param: ParameterDef): boolean {
    return this.dateRules[param.name] != null;
  }

  toggleDateRule(param: ParameterDef, enabled: boolean): void {
    const control = this.form.get(param.name);
    if (enabled) {
      this.dateRules[param.name] = this.dateRules[param.name] ?? 15;
      control?.disable({ emitEvent: false });
    } else {
      delete this.dateRules[param.name];
      control?.enable({ emitEvent: false });
    }
  }

  setDateRuleDays(param: ParameterDef, value: string | number): void {
    const days = Number(value);
    this.dateRules[param.name] = Number.isFinite(days) ? days : 0;
  }

  private onSubmitSchedule(): void {
    if (
      this.form.invalid ||
      this.submitting ||
      this.loading ||
      this.recurrenceOnceInPast() ||
      this.recurrenceCronMissing()
    ) {
      return;
    }

    const raw = this.form.getRawValue() as Record<string, string | boolean | string[]>;
    const label = String(raw['label'] ?? 'sample-run');
    const planFile = this.selectedPlan?.file ?? '';
    const baseProps: RunProps = {};

    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        baseProps[param.name] = this.serializeValue(param, raw[param.name]);
      }
    }

    const rules: ScheduleRule[] = Object.entries(this.dateRules)
      .filter(([, days]) => days != null && Number.isFinite(days))
      .map(([field, days]) => ({ field, type: 'dateOffset' as const, days: Number(days) }));

    let recurrence: ScheduleRecurrence;
    if (this.recurrenceType === 'once') {
      recurrence = {
        type: 'once',
        at: pickerDateToUtcInstant(this.recurrenceOnceAt ?? new Date()).toISOString()
      };
    } else if (this.recurrenceType === 'cron') {
      recurrence = { type: 'cron', expression: this.recurrenceCronExpression.trim() };
    } else {
      recurrence = { type: 'daily', time: this.recurrenceTime };
    }

    this.scheduleSave.emit({ label, planFile, baseProps, rules, recurrence });
  }

  setSubmitting(value: boolean): void {
    this.submitting = value;
  }

  fieldLabel(param: ParameterDef): string {
    return parameterFieldLabel(param);
  }

  fieldColumnClass(param: ParameterDef): string {
    return parameterFieldColumnClass(param);
  }

  /** True when ENABLE_IF is absent or the controlling field matches. */
  isParamEnabled(param: ParameterDef): boolean {
    const condition = param.enableIf;
    if (!condition?.field) return true;
    const current = this.normalizeEnableIfValue(this.form.get(condition.field)?.value);
    const expected = this.normalizeEnableIfValue(condition.value);
    return current === expected;
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
    const controls: Record<string, FormControl<string | boolean | string[] | null>> = {
      label: this.fb.nonNullable.control('sample-run')
    };

    for (const group of groups) {
      for (const param of group.parameters) {
        controls[param.name] = this.createControl(param);
      }
    }

    this.form = this.fb.group(controls);
    this.wireEnableIfSync();
  }

  private wireEnableIfSync(): void {
    this.enableIfSub?.unsubscribe();
    this.syncEnableIfStates();
    this.enableIfSub = this.form.valueChanges.subscribe(() => {
      this.syncEnableIfStates();
    });
  }

  private syncEnableIfStates(): void {
    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        if (!param.enableIf) continue;
        const control = this.form.get(param.name);
        if (!control) continue;
        const enabled = this.isParamEnabled(param);
        if (enabled && control.disabled) {
          control.enable({ emitEvent: false });
        } else if (!enabled && control.enabled) {
          control.disable({ emitEvent: false });
        }
      }
    }
  }

  private normalizeEnableIfValue(value: unknown): string {
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    return String(value ?? '')
      .trim()
      .toLowerCase();
  }

  private createControl(
    param: ParameterDef
  ): FormControl<string | boolean | string[] | null> {
    const validators = param.required && !param.hidden ? [Validators.required] : [];
    const initial = this.defaultControlValue(param);
    if (param.type === 'dropdown' && !param.required && !param.hidden) {
      return this.fb.control(initial as string | null, validators);
    }
    return this.fb.nonNullable.control(initial as string | boolean | string[], validators);
  }

  private finishPendingPropsLoad(): void {
    if (!this.pendingPropsFromRun) return;

    const sourceLabel = this.pendingPropsSourceLabel || 'previous run';
    const props = this.pendingPropsFromRun;
    this.pendingPropsFromRun = null;
    this.pendingPropsSourceLabel = '';

    this.applyPropsToForm(props);
    this.loadDropdownOptions();
    this.propsLoadNotice = `Loaded parameters from “${sourceLabel}”. Review fields, then start the run.`;
    this.syncEnableIfStates();
    this.cdr.markForCheck();
  }

  private applyPropsToForm(props: RunProps): void {
    let applied = 0;
    for (const group of this.parameterGroups) {
      for (const param of group.parameters) {
        const control = this.form.get(param.name);
        if (!control) continue;
        const raw = props[param.name];
        if (raw === undefined) continue;
        control.setValue(this.controlValueFromProp(param, raw), { emitEvent: false });
        applied += 1;
      }
    }

    if (applied === 0 && Object.keys(props).length > 0) {
      this.propsLoadNotice =
        'Selected run has parameters, but none matched the current plan schema. Using defaults.';
    }
  }

  private applyScheduleToForm(schedule: Schedule): void {
    this.form.get('label')?.setValue(schedule.label, { emitEvent: false });
    this.applyPropsToForm(schedule.baseProps);

    this.dateRules = {};
    for (const rule of schedule.rules) {
      if (rule.type === 'dateOffset') {
        this.dateRules[rule.field] = rule.days;
        this.form.get(rule.field)?.disable({ emitEvent: false });
      }
    }

    if (schedule.recurrence.type === 'once') {
      this.recurrenceType = 'once';
      const at = new Date(schedule.recurrence.at);
      this.recurrenceOnceAt = utcInstantToPickerDate(at);
      this.recurrenceOnceAtLocal = at;
    } else if (schedule.recurrence.type === 'cron') {
      this.recurrenceType = 'cron';
      this.recurrenceCronExpression = schedule.recurrence.expression;
      this.recurrenceCronTouched = true;
      this.cronExpressionChanges.next(schedule.recurrence.expression);
    } else {
      this.recurrenceType = 'daily';
      this.recurrenceTime = schedule.recurrence.time;
      this.syncTimePickers();
    }

    this.loadDropdownOptions();
    this.syncEnableIfStates();
    this.cdr.markForCheck();
  }

  private controlValueFromProp(
    param: ParameterDef,
    raw: string
  ): string | boolean | string[] | null {
    if (param.type === 'boolean') {
      return raw === 'true';
    }
    if (param.type === 'multiselect') {
      return raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (param.type === 'dropdown' && !param.required) {
      const trimmed = raw.trim();
      return trimmed ? trimmed : null;
    }
    return raw;
  }

  private formatPriorRunLabel(run: RunSummary): string {
    const name = run.label?.trim() || 'Unnamed run';
    const started = run.startedAt
      ? new Date(run.startedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      : '—';
    const plan = run.planFile ? run.planFile.replace(/\.jmx$/i, '') : 'plan';
    return `${name} · ${plan} · ${started} · ${run.status}`;
  }

  private suggestRerunLabel(sourceLabel: string): string {
    const base = sourceLabel.trim() || 'run';
    const suffix = '-rerun';
    if (base.endsWith(suffix)) {
      const match = base.match(/-rerun(?:-(\d+))?$/);
      const next = match?.[1] ? Number(match[1]) + 1 : 2;
      return base.replace(/-rerun(?:-\d+)?$/, `${suffix}-${next}`);
    }
    return `${base}${suffix}`;
  }

  private defaultControlValue(param: ParameterDef): string | boolean | string[] | null {
    if (param.type === 'boolean') {
      return param.defaultValue === 'true';
    }
    if (param.type === 'multiselect') {
      return param.defaultValue
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (param.type === 'dropdown' && !param.required) {
      const trimmed = param.defaultValue.trim();
      return trimmed ? trimmed : null;
    }
    return param.defaultValue;
  }

  private serializeValue(
    param: ParameterDef,
    value: string | boolean | string[] | null | undefined
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
      const control = this.form.get(name);
      if (param && control) {
        // Parent changed — wipe the selection (do not restore JMX defaults).
        control.setValue(this.emptyControlValue(param), { emitEvent: false });
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

  /** Empty selection for a field after a parent dependency changes. */
  private emptyControlValue(param: ParameterDef): string | boolean | string[] | null {
    if (param.type === 'boolean') {
      return false;
    }
    if (param.type === 'multiselect') {
      return [];
    }
    if (param.type === 'dropdown' && !param.required) {
      return null;
    }
    return '';
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
    current: string | boolean | string[] | null | undefined
  ): string[] {
    // Only preserve whatever is currently in the control (including the initial
    // JMX default set at form build). Do not re-apply JMX defaults here — that
    // would undo clearing dependents after a parent field change.
    return this.valuesFromControl(param, current);
  }

  private valuesFromControl(
    param: ParameterDef,
    current: string | boolean | string[] | null | undefined
  ): string[] {
    if (param.type === 'multiselect') {
      return Array.isArray(current)
        ? current.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
    }
    const value = String(current ?? '').trim();
    return value ? [value] : [];
  }

  private matchOptionValues(options: FieldOption[], preferred: string[]): string[] {
    const seen = new Set<string>();
    const matched: string[] = [];

    for (const token of preferred) {
      const value = this.findOptionValue(options, token);
      if (value != null && value !== '' && !seen.has(value)) {
        seen.add(value);
        matched.push(value);
      }
    }

    return matched;
  }

  private findOptionValue(options: FieldOption[], token: string): string | null | undefined {
    const needle = token.trim();
    if (!needle) return undefined;

    const normalized = needle.toLowerCase();
    const hit = options.find(
      (option) =>
        option.value === needle ||
        (option.value != null &&
          (option.value.toLowerCase() === normalized ||
            option.label.toLowerCase() === normalized ||
            option.label.toLowerCase().replace(/\s+/g, '') === normalized.replace(/\s+/g, '')))
    );

    return hit ? hit.value : undefined;
  }

  private applyDefaultPopulateFirstElement(param: ParameterDef, options: FieldOption[]): void {
    if (!param.apiConfig?.defaultPopulateFirstElement || !options.length) return;

    const control = this.form.get(param.name);
    if (!control) return;

    const current = control.value;
    const hasValue =
      param.type === 'multiselect'
        ? Array.isArray(current) && current.length > 0
        : current != null && String(current).trim() !== '';

    const valueIsValid =
      param.type === 'multiselect'
        ? Array.isArray(current) &&
          current.length > 0 &&
          current.every((entry) => options.some((option) => option.value === entry))
        : options.some((option) => option.value === String(current ?? ''));

    if (hasValue && valueIsValid) return;

    const firstValue = options.find((option) => option.value != null && option.value !== '')?.value;
    if (firstValue == null) return;

    const nextValue = param.type === 'multiselect' ? [firstValue] : firstValue;
    control.setValue(nextValue);
    this.onDropdownChange(param.name);
  }
}
