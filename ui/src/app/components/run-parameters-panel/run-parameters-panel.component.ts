import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { RunnerService } from '../../core/services/runner.service';
import {
  FieldOption,
  ParameterDef,
  ParameterGroup,
  RunProps
} from '../../core/models/runner.models';
import { formatFieldLabel, parameterFieldLabel } from '../../core/utils/format-field-label';
import { parameterFieldColumnClass } from '../../core/utils/parameter-grid-column';
import { formatRunParameterDisplayValue } from '../../core/utils/format-run-parameter-value';
import {
  apiDependenciesReady,
  isApiOptionsField,
  resolveApiFieldDisplayValue
} from '../../core/utils/resolve-field-option-display';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

export interface RunParameterRow {
  name: string;
  label: string;
  displayValue: string;
  description: string;
  isEmpty: boolean;
  columnClass: string;
}

export interface RunParameterGroupView {
  id: string;
  title: string;
  iconClass: string;
  rows: RunParameterRow[];
}

@Component({
  selector: 'app-run-parameters-panel',
  imports: [CommonModule, MessageModule, ProgressSpinnerModule],
  templateUrl: './run-parameters-panel.component.html',
  styleUrl: './run-parameters-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RunParametersPanelComponent {
  private readonly runner = inject(RunnerService);

  readonly planFile = input<string | null>(null);
  readonly props = input<RunProps>({});

  readonly loading = signal(false);
  readonly optionsLoading = signal(false);
  readonly error = signal('');
  readonly schemaGroups = signal<ParameterGroup[]>([]);
  readonly fieldOptions = signal<Record<string, FieldOption[]>>({});
  readonly activeGroupId = signal('');

  readonly groups = computed(() =>
    this.buildGroupViews(this.schemaGroups(), this.props(), this.fieldOptions())
  );

  private schemaLoadedForPlan: string | null = null;
  private optionsLoadedKey = '';

  constructor() {
    effect(() => {
      const planFile = this.planFile();
      untracked(() => this.loadSchema(planFile));
    });

    effect(() => {
      const planFile = this.planFile();
      const groups = this.schemaGroups();
      const props = this.props();
      untracked(() => {
        if (planFile && groups.length) {
          this.resolveApiFieldOptions(groups, props, planFile);
        }
      });
    });

    effect(() => {
      const views = this.groups();
      const current = this.activeGroupId();
      if (!views.some((group) => group.id === current)) {
        this.activeGroupId.set(views[0]?.id ?? '');
      }
    });
  }

  setActiveGroup(id: string): void {
    this.activeGroupId.set(id);
  }

  activeGroup(): RunParameterGroupView | undefined {
    return this.groups().find((group) => group.id === this.activeGroupId());
  }

  totalParameterCount(): number {
    return this.groups().reduce((sum, group) => sum + group.rows.length, 0);
  }

  isTechnicalValue(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '—') return false;
    return (
      /^Bearer\s+/i.test(trimmed) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ||
      /^CATEGORY_TYPE_/i.test(trimmed)
    );
  }

  private loadSchema(planFile: string | null): void {
    if (!planFile) {
      this.schemaLoadedForPlan = null;
      this.optionsLoadedKey = '';
      this.schemaGroups.set([]);
      this.fieldOptions.set({});
      this.error.set('');
      this.loading.set(false);
      this.optionsLoading.set(false);
      return;
    }

    if (planFile === this.schemaLoadedForPlan) {
      return;
    }

    this.schemaLoadedForPlan = planFile;
    this.optionsLoadedKey = '';
    this.fieldOptions.set({});
    this.loading.set(true);
    this.error.set('');

    this.runner.getParameters(planFile).subscribe({
      next: (schema) => {
        this.schemaGroups.set(schema.groups);
        this.loading.set(false);
      },
      error: (err) => {
        this.schemaGroups.set([]);
        this.error.set(err?.error?.error || err?.message || 'Could not load parameter labels');
        this.loading.set(false);
      }
    });
  }

  private resolveApiFieldOptions(groups: ParameterGroup[], props: RunProps, planFile: string): void {
    const apiParams = groups
      .flatMap((group) => group.parameters)
      .filter((param) => isApiOptionsField(param));

    if (!apiParams.length) {
      this.fieldOptions.set({});
      this.optionsLoading.set(false);
      return;
    }

    const cacheKey = `${planFile}:${JSON.stringify(props)}`;
    if (cacheKey === this.optionsLoadedKey) {
      return;
    }
    this.optionsLoadedKey = cacheKey;

    this.optionsLoading.set(true);
    const optionsMap: Record<string, FieldOption[]> = {};
    const pending = new Map(apiParams.map((param) => [param.name, param]));

    const runWave = (): void => {
      const ready = [...pending.values()].filter((param) => apiDependenciesReady(param, props));

      if (!ready.length) {
        this.fieldOptions.set({ ...optionsMap });
        this.optionsLoading.set(false);
        return;
      }

      forkJoin(
        ready.map((param) =>
          this.runner.getFieldOptions({ planFile, field: param.name, props }).pipe(
            map((response) => ({ name: param.name, options: response.options })),
            catchError(() => of({ name: param.name, options: [] as FieldOption[] }))
          )
        )
      ).subscribe((results) => {
        for (const result of results) {
          optionsMap[result.name] = result.options;
          pending.delete(result.name);
        }
        runWave();
      });
    };

    runWave();
  }

  private buildGroupViews(
    schemaGroups: ParameterGroup[],
    props: RunProps,
    optionsByField: Record<string, FieldOption[]>
  ): RunParameterGroupView[] {
    if (!schemaGroups.length) {
      return this.buildFallbackGroups(props);
    }

    const paramByName = new Map<string, ParameterDef>(
      schemaGroups.flatMap((group) => group.parameters.map((param) => [param.name, param] as const))
    );
    const seen = new Set<string>();

    const views: RunParameterGroupView[] = schemaGroups.map((group) => {
      const rows = group.parameters.map((param) => {
        seen.add(param.name);
        return this.toRow(param, props[param.name], optionsByField[param.name]);
      });
      return {
        id: group.id,
        title: group.title,
        iconClass: this.groupIconClass(group),
        rows
      };
    });

    const extraRows = Object.keys(props)
      .filter((name) => !seen.has(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) =>
        this.toRow(paramByName.get(name), props[name], optionsByField[name], name)
      );

    if (extraRows.length) {
      views.push({
        id: 'other',
        title: 'Other parameters',
        iconClass: 'pi-ellipsis-h',
        rows: extraRows
      });
    }

    return views.filter((group) => group.rows.length > 0);
  }

  private buildFallbackGroups(props: RunProps): RunParameterGroupView[] {
    const rows = Object.keys(props)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => this.toRow(undefined, props[name], undefined, name));

    if (!rows.length) return [];

    return [
      {
        id: 'run-props',
        title: 'Run configuration',
        iconClass: 'pi-sliders-h',
        rows
      }
    ];
  }

  private toRow(
    param: ParameterDef | undefined,
    raw: string | undefined,
    options: FieldOption[] | undefined,
    name = param?.name ?? ''
  ): RunParameterRow {
    const value = String(raw ?? '').trim();
    const displayValue = param
      ? resolveApiFieldDisplayValue(param, value, options)
      : formatRunParameterDisplayValue(undefined, value);

    return {
      name,
      label: param ? this.fieldLabel(param) : formatFieldLabel(name),
      displayValue,
      description: param?.description ?? '',
      isEmpty: !value,
      columnClass: param ? parameterFieldColumnClass(param) : parameterFieldColumnClass({})
    };
  }

  private fieldLabel(param: ParameterDef): string {
    return parameterFieldLabel(param);
  }

  private groupIconClass(group: ParameterGroup): string {
    const key = `${group.id} ${group.title}`.toLowerCase();
    if (key.includes('header')) return 'pi-arrow-right-arrow-left';
    if (key.includes('global')) return 'pi-globe';
    if (key.includes('config')) return 'pi-cog';
    if (key.includes('env')) return 'pi-server';
    if (key.includes('request')) return 'pi-calendar';
    if (key.includes('customer')) return 'pi-users';
    return 'pi-folder';
  }
}
