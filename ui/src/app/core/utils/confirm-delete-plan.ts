import { ConfirmationService } from 'primeng/api';

export function confirmDeletePlan(
  confirmation: ConfirmationService,
  planFile: string,
  onAccept: () => void
): void {
  confirmation.confirm({
    header: 'Delete plan',
    message: `Delete "${planFile}"? This permanently removes the JMX file from the plans folder.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Delete',
    rejectLabel: 'Cancel',
    acceptIcon: 'pi pi-trash',
    rejectIcon: 'pi pi-times',
    acceptButtonProps: { severity: 'danger' },
    rejectButtonProps: { severity: 'secondary' },
    defaultFocus: 'reject',
    dismissableMask: true,
    accept: onAccept
  });
}
