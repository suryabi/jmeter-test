import { ConfirmationService } from 'primeng/api';

export function confirmDeleteRun(
  confirmation: ConfirmationService,
  runName: string,
  onAccept: () => void
): void {
  confirmation.confirm({
    header: 'Delete run',
    message: `Delete run "${runName}"? This permanently removes logs, JTL, and HTML report files from disk.`,
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
