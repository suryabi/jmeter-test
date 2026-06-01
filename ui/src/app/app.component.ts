import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfirmDialog } from 'primeng/confirmdialog';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ConfirmDialog],
  template: `
    <router-outlet />
    <p-confirmdialog styleClass="biq-confirm-dialog" />
  `,
  styles: [':host { display: block; min-height: 100vh; }']
})
export class AppComponent {}
