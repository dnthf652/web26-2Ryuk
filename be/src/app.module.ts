import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppGateway } from './app.gateway';
import { AppService } from './app.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { GameModule } from './modules/game/game.module';
import { RoomModule } from './modules/room/room.module';
import databaseConfig from './providers/database/database.config';
import { RedisModule } from './providers/redis/redis.module';
// Entities
import { Comment } from './modules/comment/comment.entity';
import { GameRecord } from './modules/game/game-record.entity';
import { Game } from './modules/game/game.entity';
import { ChattingLog } from './modules/log/chatting-log.entity';
import { PostLike } from './modules/post/post-like.entity';
import { PostPicture } from './modules/post/post-picture.entity';
import { Post } from './modules/post/post.entity';
import { ChattingReport } from './modules/report/chatting-report.entity';
import { User } from './modules/user/user.entity';
import { VoiceModule } from './modules/voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      ...databaseConfig,
      entities: [User, ChattingReport, Post, PostPicture, PostLike, ChattingLog, Game, GameRecord, Comment],
      // 개발 환경에서는 마이그레이션 자동 실행 비활성화 (CLI로 별도 실행)
      migrationsRun: false,
      migrations: [],
    }),
    RedisModule,
    ChatModule,
    RoomModule,
    AuthModule,
    VoiceModule,
    GameModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AppGateway,
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
