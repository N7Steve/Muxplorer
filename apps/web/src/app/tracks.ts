import { Component, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import type { TrackChoice, Track } from '@muxplorer/shared';
import { Icon } from './icon';
export interface EditableTrack extends TrackChoice {
  metadata: Track;
  sourceName: string;
}
@Component({
  selector: 'mx-tracks',
  standalone: true,
  imports: [FormsModule, DragDropModule, Icon],
  template: ` <div class="track-table">
    <div class="track-header">
      <span></span><span>Pista / códec</span><span>Nombre</span><span>Idioma</span
      ><span title="Predeterminada">Default</span><span title="Forzada">Forced</span>
    </div>
    <div cdkDropList (cdkDropListDropped)="drop($event)">
      @for (track of tracks(); track track.source + ':' + track.id) {
        <div class="track-row" cdkDrag [class.track-disabled]="!track.enabled">
          <div class="track-select">
            <button class="drag-handle" cdkDragHandle title="Arrastrar para ordenar">
              <mx-icon name="GripVertical" [size]="15" /></button
            ><input
              type="checkbox"
              [(ngModel)]="track.enabled"
              [attr.aria-label]="'Conservar pista ' + track.id + ' de ' + track.sourceName"
            />
          </div>
          <div class="track-description">
            <b
              ><mx-icon
                [name]="
                  track.metadata.type === 'video'
                    ? 'Film'
                    : track.metadata.type === 'audio'
                      ? 'FileAudio'
                      : 'File'
                "
                [size]="15"
              />{{ track.metadata.codec }}</b
            ><small
              >{{ track.metadata.type }} ·
              {{ track.metadata.channels ? track.metadata.channels + ' canales · ' : ''
              }}{{ track.metadata.resolution || '' }}</small
            ><small class="source-label" [title]="track.sourceName"
              >{{ track.sourceName }} · #{{ track.id }}</small
            >
          </div>
          <input
            [(ngModel)]="track.name"
            placeholder="Nombre de pista"
            [disabled]="!track.enabled"
            aria-label="Nombre de pista"
          /><input
            [(ngModel)]="track.language"
            placeholder="und"
            [disabled]="!track.enabled"
            aria-label="Idioma BCP 47"
            maxlength="35"
          />
          <input
            type="checkbox"
            [(ngModel)]="track.default"
            [disabled]="!track.enabled"
            aria-label="Pista predeterminada"
          /><input
            type="checkbox"
            [(ngModel)]="track.forced"
            [disabled]="!track.enabled"
            aria-label="Pista forzada"
          />
        </div>
      }
    </div>
  </div>`,
})
export class Tracks {
  readonly tracks = input.required<EditableTrack[]>();
  drop(event: CdkDragDrop<EditableTrack[]>) {
    moveItemInArray(this.tracks(), event.previousIndex, event.currentIndex);
  }
}
