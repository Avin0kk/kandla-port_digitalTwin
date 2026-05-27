import { Component } from '@angular/core';
import { Map3dComponent } from './map-3d/map-3d';

@Component({
  selector: 'app-root',
  imports: [Map3dComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
  standalone: true
})
export class App {}
