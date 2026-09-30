// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 withdraw4 zkey sha256=1910d2f24d8e58972a5a4a57ec1d7bf19df3dd07c0aad347925f29e310febf7a
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendWithdrawVerifier4 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 9081565959299832578038429853201178068282843480800556385221472457443941072948;
    uint256 constant IC0y = 7967799615220518924167889210727147584779777318842596651913970370090090899213;

    uint256 constant IC1x = 14239140536998071445226413840701372043364857900434927392249508875375489073881;
    uint256 constant IC1y = 3289677600030824455481120501392032047428769975766340149134898983308656394556;

    uint256 constant IC2x = 4066958093005574840968433174961853626690459057126648456358563204073664506093;
    uint256 constant IC2y = 12517081786835491119421314195933527824329932012885311682399565406170573743915;

    uint256 constant IC3x = 15510778270823543701780959758188962208364411980008424266294160543732231167558;
    uint256 constant IC3y = 11097261142276480034772572595620081473575368447170277979025622188428569372772;

    uint256 constant IC4x = 7043788099020241623298079264076263359689052608395364730935260989623137682350;
    uint256 constant IC4y = 8651565891490174564116776660124659745127415269234833202638254513241075898143;

    uint256 constant IC5x = 18404948105899882408683596205607605068937798651354307884348339251129364346625;
    uint256 constant IC5y = 13312257503080620453805665643733006774409751121480758940276611482590232938036;

    uint256 constant IC6x = 11604347135273904493662742583982354257927695261185172155582408447414829773384;
    uint256 constant IC6y = 9285478415450528514828339146852763932141500498274651767212927812860869720732;

    uint256 constant IC7x = 5401286773130868395052327555606658958144161629694848159104417871176443450835;
    uint256 constant IC7y = 8870349763807194267939672314706511243094065392710806539422057907671032100434;

    uint256 constant IC8x = 17225628108738324004849326764823101562349965536443117517090184962569396262444;
    uint256 constant IC8y = 7631274581040476493990632973553428274887512045659887261481897882186425606790;

    uint256 constant IC9x = 14742147752981705413721081498531388531396919210406720485229346101620101781939;
    uint256 constant IC9y = 8997722256771798598878608515064890646483644877561318416138277944302407982430;

    uint256 constant IC10x = 16665763672060645600709211385740302541932102360612942335803532971165492636537;
    uint256 constant IC10y = 1118664207927831414912586362236752719941374589686648564802212336952885690257;

    uint256 constant IC11x = 14767310957006894146120742991847218028851273854872142049214190100630479941087;
    uint256 constant IC11y = 1469397761219421691093222017204270981437401461181318508276523808140951944532;

    uint256 constant IC12x = 11985764574901356080582017187363616889378353865225647967999575543087066942493;
    uint256 constant IC12y = 14119131924679149731937939603712940989249276929359199880550695507909773524266;

    uint256 constant IC13x = 8157609161602738242531944983502829301550979503226958851208553146736486221328;
    uint256 constant IC13y = 12633586122076015810713974800335965733401543455019839062369043762063166219555;

    uint256 constant IC14x = 10651672293501420458083503839977399070881237452496108803064775145060243749311;
    uint256 constant IC14y = 8998922737164275888966772668535177639434428628209146991384471325622045488904;

    uint256 constant IC15x = 5168421224864716208078644543416174827056665029821915719287215979515612010717;
    uint256 constant IC15y = 19471633730192815433426087078404563392281674259211668526886838595799536373144;

    uint256 constant IC16x = 770504713600884051710544143003288774194802878348494727393663997740144953667;
    uint256 constant IC16y = 11283111040237797142454267803981700297628025254441200332656873953706524466439;

    uint256 constant IC17x = 6106194686983976463280199372159814137283724284412201620136488236887574985746;
    uint256 constant IC17y = 1964181723546084624885415498828334473017925633260924351018116940401833692602;

    uint256 constant IC18x = 11905538354649027004434308496407149074901929176573546669515581711786168819129;
    uint256 constant IC18y = 3256577300414337688693384750501773187053039655479616795137490587754920171312;

    uint256 constant IC19x = 20400065324607487641404555465483712656374549806274650900613651524825519061293;
    uint256 constant IC19y = 12026252227930317128162101830279725149820307215078513089193709499583000042343;

    uint256 constant IC20x = 17098553873762422867886347202103023607873568596919068318752668054431265971340;
    uint256 constant IC20y = 6386268228925468893090777799451195802013219456802018284460639747990643524668;

    uint256 constant IC21x = 14917657082139030970098656840843473775434609422017810327866646014142227745680;
    uint256 constant IC21y = 12250399633283583395891183597544819711850950429043218798444709536734265814141;

    uint256 constant IC22x = 6449794372252942168525684902193932024246545018774221447981132590818969486750;
    uint256 constant IC22y = 10290185478008494237929954150767926369828259787237950529724688236627907688024;

    uint256 constant IC23x = 9746520527651567481332041864128858847616739066675829252435459965410890517152;
    uint256 constant IC23y = 21554911565799548291408970353935649416209666661679906874716868767804903255833;

    uint256 constant IC24x = 19798104521369461521704965469281415189578222155616495449031007794306746262111;
    uint256 constant IC24y = 13692306535170849742008599820425483736719540604240501447876969909218554161175;

    uint256 constant IC25x = 20263476305411009769020668605975857421187501038614982209477834427966254880403;
    uint256 constant IC25y = 1502172321150269420991800067160935398262867527678547802081547585650222767025;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
