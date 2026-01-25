import { ForbiddenException, Logger, NotFoundException, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WsExceptionFilter } from '@src/common/filters/ws-exception.filter';
import { WsJsonParsePipe } from '@src/common/pipes/ws-json-parse.pipe';
import { createWsErrorResponse } from '@src/common/utils/ws-error-code';
import { Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { RoomService } from '../room/room.service';
import {
  ConsumerStateChangeDto,
  CreateConsumerDto,
  CreateProducerDto,
  GetProducersDto,
  GetRouterRtpCapabilitiesDto,
  LeaveVoiceRoomDto,
  ProducerStateChangeDto,
  VoiceTransportCloseDto,
  VoiceTransportConnectDto,
  VoiceTransportCreateDto,
} from './dto/voice.dto';
import { VoiceService } from './voice.service';

interface SocketWithAuth extends Socket {
  data: {
    userId: string;
  };
}

@UseFilters(new WsExceptionFilter())
@WebSocketGateway({ namespace: '/' })
@UsePipes(
  new WsJsonParsePipe(),
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: false,
    skipMissingProperties: false,
    transformOptions: {
      enableImplicitConversion: true,
    },
  }),
)
export class VoiceGateway {
  private readonly logger = new Logger(VoiceGateway.name);

  constructor(
    private readonly voiceService: VoiceService,
    private readonly roomService: RoomService,
    private readonly authService: AuthService,
  ) {}

  /**
   * 클라이언트의 인증 및 인가(방 참여 여부)를 확인하는 헬퍼 메서드
   */
  private async _authorizeClient(client: SocketWithAuth, roomId: string): Promise<string> {
    const { userId } = client.data;
    if (!userId) {
      throw new Error('UNAUTHORIZED');
    }

    const isUserInRoom = await this.roomService.isUserInRoom(userId, roomId);
    if (!isUserInRoom) {
      throw new Error('FORBIDDEN');
    }
    return userId;
  }

  /**
   * 클라이언트가 방의 Router의 RTP Capabilities를 요청할 때 처리
   */
  @SubscribeMessage('voice:router:capabilities')
  async handleGetRouterRtpCapabilities(
    @MessageBody() data: GetRouterRtpCapabilitiesDto,
    @ConnectedSocket() client: SocketWithAuth,
  ) {
    try {
      const room_Id = data.room_Id;
      await this._authorizeClient(client, room_Id);

      const rtpCapabilities = await this.voiceService.getRouterRtpCapabilities(room_Id);
      return { rtpCapabilities };
    } catch (error) {
      return { error: createWsErrorResponse(error, '라우터 기능 조회 중 오류가 발생했습니다.') };
    }
  }
  /**
   * WebRTC Transport 생성
   */
  @SubscribeMessage('voice:transport:create')
  async handleCreateTransport(@MessageBody() data: VoiceTransportCreateDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      await this._authorizeClient(client, data.room_id);
      const transportInfo = await this.voiceService.createTransport(data.room_id, data.producing, client);
      return transportInfo;
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'WebRTC Transport 생성 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * 클라이언트 Transport의 DTLS 파라미터를 받아 연결
   */
  @SubscribeMessage('voice:transport:connect')
  async handleConnectTransport(
    @MessageBody() data: VoiceTransportConnectDto,
    @ConnectedSocket() client: SocketWithAuth,
  ) {
    try {
      await this._authorizeClient(client, data.room_id);
      const result = await this.voiceService.connectTransport(data);
      return result;
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'WebRTC Transport 연결 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Producer 생성
   */
  @SubscribeMessage('voice:producer:create')
  async handleCreateProducer(@MessageBody() data: CreateProducerDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      const producer = await this.voiceService.createProducer(data, userId);

      // 다른 참여자들에게 새 producer 생성 알림
      client.to(data.room_id).emit('voice:producer:new', {
        producerUserId: userId,
        producerId: producer.id,
      });

      return { producer_id: producer.id };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Producer 생성 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * 방의 모든 Producer 목록 조회
   */
  @SubscribeMessage('voice:room:producers')
  async handleGetProducers(@MessageBody() data: GetProducersDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      await this._authorizeClient(client, data.room_id);
      const producers = await this.voiceService.getProducersForRoom(data.room_id);
      return { producers };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, '방의 Producer 목록 조회 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Producer 일시 중지
   */
  @SubscribeMessage('voice:producer:pause')
  async handlePauseProducer(@MessageBody() data: ProducerStateChangeDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.pauseProducer(data.producer_id, userId);

      // 다른 참여자들에게 상태 변경 알림
      client.to(data.room_id).emit('voice:producer:update', {
        user_id: userId,
        is_mic_on: 'false',
      });
      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Producer 일시 중지 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Producer 재개
   */
  @SubscribeMessage('voice:producer:resume')
  async handleResumeProducer(@MessageBody() data: ProducerStateChangeDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.resumeProducer(data.producer_id, userId);

      // 다른 참여자들에게 상태 변경 알림
      client.to(data.room_id).emit('voice:producer:update', {
        user_id: userId,
        is_mic_on: 'true',
      });
      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Producer 재개 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Producer 종료
   */
  @SubscribeMessage('voice:producer:close')
  async handleCloseProducer(@MessageBody() data: ProducerStateChangeDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.closeProducer(data.producer_id, userId);

      // 다른 참여자들에게 producer 종료 알림
      client.to(data.room_id).emit('voice:producer:closed', {
        user_id: userId,
      });
      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Producer 종료 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Consumer 생성
   */
  @SubscribeMessage('voice:consumer:create')
  async handleCreateConsumer(@MessageBody() data: CreateConsumerDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const transportData = await this.voiceService.getTransportMetadata(data.transport_id);
      if (!transportData?.room_id) {
        throw new NotFoundException(`Transport ${data.transport_id} 정보를 찾을 수 없습니다.`);
      }
      const { room_id, user_id: transportOwnerId } = transportData;

      const userId = await this._authorizeClient(client, room_id);

      if (userId !== transportOwnerId) {
        throw new ForbiddenException(`Transport ${data.transport_id}에 대한 소유권이 없습니다.`);
      }

      const consumerInfo = await this.voiceService.createConsumer(data, userId);

      return consumerInfo;
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Consumer 생성 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Consumer 일시 중지
   */
  @SubscribeMessage('voice:consumer:pause')
  async handlePauseConsumer(@MessageBody() data: ConsumerStateChangeDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.pauseConsumer(data.consumer_id, userId);

      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Consumer 일시 중지 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Consumer 재개
   */
  @SubscribeMessage('voice:consumer:resume')
  async handleResumeConsumer(@MessageBody() data: ConsumerStateChangeDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.resumeConsumer(data.consumer_id, userId);

      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Consumer 재개 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * Consumer 종료
   */
  @SubscribeMessage('voice:consumer:close')
  async handleCloseConsumer(@MessageBody() data: ConsumerStateChangeDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.closeConsumer(data.consumer_id, userId);

      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'Consumer 종료 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * 음성 채팅방 나가기
   */
  @SubscribeMessage('voice:room:leave')
  async handleLeaveVoiceRoom(@MessageBody() data: LeaveVoiceRoomDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      const userId = await this._authorizeClient(client, data.room_id);
      await this.voiceService.leaveRoom(userId, data.room_id);

      return { success: true };
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, '음성 채팅방 나가기 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }

  /**
   * 클라이언트 Transport 종료
   * @param data room_id, transport_id
   * @param client Socket
   */
  @SubscribeMessage('voice:transport:close')
  async handleCloseTransport(@MessageBody() data: VoiceTransportCloseDto, @ConnectedSocket() client: SocketWithAuth) {
    try {
      await this._authorizeClient(client, data.room_id);
      const result = await this.voiceService.closeTransport(data);
      return result;
    } catch (error) {
      const errorResponse = createWsErrorResponse(error, 'WebRTC Transport 종료 중 오류가 발생했습니다.');
      return { error: errorResponse };
    }
  }
}
