'use client'
import { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';

interface PartnerFoundData {
  roomId: string;
  isInitiator: boolean;
}

// Update the connection URL to use the new Railway URL by default.
const socket: Socket = io(
  process.env.NEXT_PUBLIC_BACKEND_URL || 'https://audio-omegle-server-production.up.railway.app/'
);

const ChatComponent: React.FC = () => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Idle');
  const [error, setError] = useState<string | null>(null);
  const [autoSearch, setAutoSearch] = useState<boolean>(true);
  // New state to track the socket connection status.
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  useEffect(() => {
    // Listen for socket connection events.
    socket.on('connect', () => {
      setSocketConnected(true);
    });
    socket.on('disconnect', () => {
      setSocketConnected(false);
      setStatus('Disconnected from server');
      cleanupCall();
    });

    // Listen for the "partnerFound" event.
    socket.on('partnerFound', async (data: PartnerFoundData) => {
      setRoomId(data.roomId);
      setStatus('Partner found, starting call...');
      await startCall(data.roomId, data.isInitiator);
    });

    socket.on('offer', async ({ offer }: { offer: RTCSessionDescriptionInit; }) => {
      if (!peerConnectionRef.current) await startCall(roomId, false);
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(offer);
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socket.emit('answer', { roomId, answer });
      }
    });

    socket.on('answer', async ({ answer }: { answer: RTCSessionDescriptionInit; }) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(answer);
      }
    });

    socket.on('ice-candidate', async ({ candidate }: { candidate: RTCIceCandidateInit; }) => {
      if (peerConnectionRef.current && candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(candidate);
        } catch (err) {
          console.error('Error adding candidate:', err);
        }
      }
    });

    // Listen for a "hangup" event from the remote peer.
    socket.on('hangup', () => {
      setStatus('Partner hung up');
      cleanupCall();
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('partnerFound');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('hangup');
    };
  }, [roomId]);

  const startCall = async (room: string | null, isInitiator: boolean) => {
    if (!room) return;
    try {
      // Create the RTCPeerConnection.
      peerConnectionRef.current = new RTCPeerConnection(rtcConfig);
      setStatus('Initializing call...');

      // Monitor connection state changes.
      peerConnectionRef.current.onconnectionstatechange = () => {
        const state = peerConnectionRef.current?.connectionState;
        console.log('Connection state changed:', state);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          cleanupCall();
        }
      };

      // Get local media stream.
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, stream);
      });

      // When remote tracks are received.
      peerConnectionRef.current.ontrack = (event: RTCTrackEvent) => {
        const [remoteStream] = event.streams;
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
      };

      // Handle ICE candidates.
      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { roomId: room, candidate: event.candidate });
        }
      };

      if (isInitiator) {
        const offer = await peerConnectionRef.current.createOffer();
        await peerConnectionRef.current.setLocalDescription(offer);
        socket.emit('offer', { roomId: room, offer });
      }
    } catch (err: any) {
      console.error('Error starting call:', err);
      setError(`Error starting call: ${err.message}`);
      setStatus('Error');
    }
  };

  const cleanupCall = () => {
    // Stop local media tracks.
    if (localVideoRef.current && localVideoRef.current.srcObject) {
      const stream = localVideoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      localVideoRef.current.srcObject = null;
    }
    // Close the peer connection.
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    setRoomId(null);
    setStatus('Idle');
    if (autoSearch) {
      setStatus('Searching for a partner...');
      setTimeout(() => {
        socket.emit('findPartner');
      }, 500);
    }
  };

  const handleButtonClick = () => {
    if (roomId) {
      socket.emit('hangup', { roomId });
      cleanupCall();
    } else {
      setStatus('Searching for a partner...');
      socket.emit('findPartner');
    }
  };

  const toggleAutoSearch = () => {
    setAutoSearch(!autoSearch);
  };

  return (
    <div className="bg-gray-900 text-white rounded-lg shadow-lg p-6 max-w-2xl mx-auto my-8">
      <h1 className="text-3xl font-bold mb-4 text-center">Omegle Clone Chat</h1>
      
      {/* Socket connection status indicator */}
      <div className="text-center mb-4">
        <span
          className={`px-2 py-1 rounded-full text-sm font-medium ${
            socketConnected ? 'bg-green-600' : 'bg-red-600'
          }`}
        >
          {socketConnected ? 'Connected to Server' : 'Disconnected'}
        </span>
      </div>

      <p className="text-lg mb-4 text-center">
        Status: <span className="font-semibold">{status}</span>
      </p>
      {error && <p className="text-red-500 mb-4 text-center">{error}</p>}
      
      <div className="flex justify-center mb-4">
        <button
          onClick={handleButtonClick}
          className={`${
            roomId ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
          } text-white font-semibold py-2 px-6 rounded`}
        >
          {roomId ? 'Next' : 'Search'}
        </button>
      </div>
      
      <div className="text-center mb-4">
        <button onClick={toggleAutoSearch} className="text-sm text-gray-300 underline">
          {autoSearch ? 'Stop Auto Search' : 'Enable Auto Search'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl font-medium mb-2 text-center">Local Video</h2>
          <video ref={localVideoRef} autoPlay muted className="w-full rounded border border-gray-700" />
        </div>
        <div>
          <h2 className="text-xl font-medium mb-2 text-center">Remote Video</h2>
          <video ref={remoteVideoRef} autoPlay className="w-full rounded border border-gray-700" />
        </div>
      </div>
    </div>
  );
};

export default ChatComponent;